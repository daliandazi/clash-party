import { getAppConfig } from '../config'
import { mainWindow } from '../window'
import {
  mihomoChangeProxy,
  mihomoCloseAllConnections,
  mihomoGroups,
  mihomoProxyDelay
} from './mihomoApi'

export interface AutoSwitchCandidateProxy {
  name: string
  provider?: string
  regionId?: string
}

type AutoProxySwitchCheckReason = 'manual' | 'active' | 'standby'
type AutoSwitchTimer = ReturnType<typeof setTimeout> | number

interface TargetGroupContext {
  group: IMihomoMixedGroup
  current: AutoSwitchCandidateProxy
  currentRegion?: IProxyAutoSwitchRegion
  candidates: AutoSwitchCandidateProxy[]
}

export interface AutoProxySwitchDeps {
  getAppConfig: () => Promise<Partial<IAppConfig>>
  mihomoGroups: (includeHidden?: boolean) => Promise<IMihomoMixedGroup[]>
  mihomoProxyDelay: (proxy: string, url?: string, provider?: string) => Promise<IMihomoDelay>
  mihomoChangeProxy: (group: string, proxy: string) => Promise<IMihomoProxy>
  mihomoCloseAllConnections: () => Promise<void>
  notify?: (state: IProxyAutoSwitchState) => void
  now?: () => Date
  setTimer?: (handler: () => void, timeout: number) => AutoSwitchTimer
  clearTimer?: (timer: AutoSwitchTimer) => void
}

export const DEFAULT_AUTO_SWITCH_CONFIG: IProxyAutoSwitchConfig = {
  enabled: false,
  targetGroup: '',
  activeIntervalSec: 15,
  standbyIntervalSec: 300,
  switchCooldownSec: 180,
  maxDelayMs: 800,
  failureThreshold: 2,
  closeConnectionsOnSwitch: true,
  delayConcurrency: 4,
  retryTimeoutOnce: true,
  excludePatterns: [],
  regions: [
    { id: 'us', name: '美国', patterns: ['US', '美国', 'United States'], enabled: true },
    { id: 'jp', name: '日本', patterns: ['JP', '日本', 'Japan'], enabled: true },
    { id: 'sg', name: '新加坡', patterns: ['SG', '新加坡', 'Singapore'], enabled: true },
    { id: 'hk', name: '香港', patterns: ['HK', '香港', 'Hong Kong'], enabled: true }
  ]
}

const MIN_ACTIVE_INTERVAL_SEC = 5
const MIN_STANDBY_INTERVAL_SEC = 30
const MIN_SWITCH_COOLDOWN_SEC = 30
const MIN_FAILURE_THRESHOLD = 1
const MIN_MAX_DELAY_MS = 1
const MIN_DELAY_CONCURRENCY = 1
const MAX_DELAY_CONCURRENCY = 20

function cloneDefaultConfig(): IProxyAutoSwitchConfig {
  return JSON.parse(JSON.stringify(DEFAULT_AUTO_SWITCH_CONFIG)) as IProxyAutoSwitchConfig
}

function clampNumber(value: unknown, fallback: number, min: number, max?: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  const clamped = Math.max(Math.floor(value), min)
  return typeof max === 'number' ? Math.min(clamped, max) : clamped
}

export function normalizeAutoSwitchConfig(
  value?: Partial<IProxyAutoSwitchConfig>
): IProxyAutoSwitchConfig {
  const defaults = cloneDefaultConfig()
  const rawRegions =
    Array.isArray(value?.regions) && value.regions.length > 0 ? value.regions : defaults.regions
  const regions = rawRegions
    .filter((region): region is IProxyAutoSwitchRegion => Boolean(region))
    .map((region) => ({
      id: String(region.id || '').trim(),
      name: String(region.name || region.id || '').trim(),
      patterns: Array.isArray(region.patterns)
        ? region.patterns.map((pattern) => String(pattern).trim()).filter(Boolean)
        : [],
      enabled: region.enabled !== false
    }))
    .filter((region) => region.id && region.name)

  return {
    ...defaults,
    ...value,
    enabled: value?.enabled === true,
    targetGroup: value?.targetGroup ?? defaults.targetGroup,
    activeIntervalSec: clampNumber(
      value?.activeIntervalSec,
      defaults.activeIntervalSec,
      MIN_ACTIVE_INTERVAL_SEC
    ),
    standbyIntervalSec: clampNumber(
      value?.standbyIntervalSec,
      defaults.standbyIntervalSec,
      MIN_STANDBY_INTERVAL_SEC
    ),
    switchCooldownSec: clampNumber(
      value?.switchCooldownSec,
      defaults.switchCooldownSec,
      MIN_SWITCH_COOLDOWN_SEC
    ),
    maxDelayMs: clampNumber(value?.maxDelayMs, defaults.maxDelayMs, MIN_MAX_DELAY_MS),
    failureThreshold: clampNumber(
      value?.failureThreshold,
      defaults.failureThreshold,
      MIN_FAILURE_THRESHOLD
    ),
    closeConnectionsOnSwitch: value?.closeConnectionsOnSwitch !== false,
    delayConcurrency: clampNumber(
      value?.delayConcurrency,
      defaults.delayConcurrency,
      MIN_DELAY_CONCURRENCY,
      MAX_DELAY_CONCURRENCY
    ),
    retryTimeoutOnce: value?.retryTimeoutOnce !== false,
    excludePatterns: Array.isArray(value?.excludePatterns)
      ? value.excludePatterns.map((pattern) => String(pattern).trim()).filter(Boolean)
      : defaults.excludePatterns,
    regions: regions.length > 0 ? regions : defaults.regions
  }
}

function compilePattern(pattern: string): RegExp | undefined {
  if (pattern.startsWith('/') && pattern.lastIndexOf('/') > 0) {
    const lastSlash = pattern.lastIndexOf('/')
    const source = pattern.slice(1, lastSlash)
    const flags = pattern.slice(lastSlash + 1) || 'i'

    try {
      return new RegExp(source, flags)
    } catch {
      return undefined
    }
  }

  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(escaped, 'i')
}

export function classifyProxyRegion(
  proxyName: string,
  regions: IProxyAutoSwitchRegion[]
): IProxyAutoSwitchRegion | undefined {
  for (const region of regions) {
    if (!region.enabled) continue
    for (const pattern of region.patterns) {
      const regex = compilePattern(pattern)
      if (regex?.test(proxyName)) return region
    }
  }
  return undefined
}

function matchPattern(value: string, patterns: string[]): string | undefined {
  for (const pattern of patterns) {
    const regex = compilePattern(pattern)
    if (regex?.test(value)) return pattern
  }
  return undefined
}

export function isDelayUsable(delay: number | undefined, maxDelayMs: number): boolean {
  return typeof delay === 'number' && delay > 0 && delay <= maxDelayMs
}

export function buildRegionBuckets(
  proxies: { name: string; provider?: string }[],
  regions: IProxyAutoSwitchRegion[],
  excludePatterns: string[] = []
): {
  candidates: AutoSwitchCandidateProxy[]
  buckets: IProxyAutoSwitchBucket[]
  unknownProxies: string[]
  excludedProxies: IProxyAutoSwitchExcludedProxy[]
} {
  const enabledRegions = regions.filter((region) => region.enabled)
  const buckets: IProxyAutoSwitchBucket[] = enabledRegions.map((region) => ({
    id: region.id,
    name: region.name,
    proxies: []
  }))
  const bucketMap = new Map(buckets.map((bucket) => [bucket.id, bucket]))
  const candidates: AutoSwitchCandidateProxy[] = []
  const unknownProxies: string[] = []
  const excludedProxies: IProxyAutoSwitchExcludedProxy[] = []

  proxies.forEach((proxy) => {
    const excludedBy = matchPattern(proxy.name, excludePatterns)
    if (excludedBy) {
      excludedProxies.push({ name: proxy.name, pattern: excludedBy })
      return
    }

    const region = classifyProxyRegion(proxy.name, enabledRegions)
    if (!region) {
      unknownProxies.push(proxy.name)
      return
    }

    bucketMap.get(region.id)?.proxies.push(proxy.name)
    candidates.push({ ...proxy, regionId: region.id })
  })

  return { candidates, buckets, unknownProxies, excludedProxies }
}

export function chooseBestCandidate(
  candidates: AutoSwitchCandidateProxy[],
  config: IProxyAutoSwitchConfig,
  delays: Record<string, IProxyAutoSwitchDelayEntry>,
  currentProxy?: string
): AutoSwitchCandidateProxy | undefined {
  for (const region of config.regions.filter((item) => item.enabled)) {
    const regionCandidates = candidates
      .filter((candidate) => candidate.regionId === region.id && candidate.name !== currentProxy)
      .map((candidate) => ({ candidate, delay: delays[candidate.name]?.delay }))
      .filter(({ delay }) => isDelayUsable(delay, config.maxDelayMs))
      .sort((a, b) => (a.delay ?? Number.MAX_SAFE_INTEGER) - (b.delay ?? Number.MAX_SAFE_INTEGER))

    if (regionCandidates[0]) return regionCandidates[0].candidate
  }

  return undefined
}

function initialState(): IProxyAutoSwitchState {
  return {
    running: false,
    paused: false,
    checkingActive: false,
    checkingStandby: false,
    consecutiveFailures: {},
    lastDelays: {},
    buckets: [],
    unknownProxies: [],
    excludedProxies: []
  }
}

function cloneState(state: IProxyAutoSwitchState): IProxyAutoSwitchState {
  return {
    ...state,
    consecutiveFailures: { ...state.consecutiveFailures },
    lastDelays: { ...state.lastDelays },
    buckets: state.buckets.map((bucket) => ({ ...bucket, proxies: [...bucket.proxies] })),
    unknownProxies: [...state.unknownProxies],
    excludedProxies: state.excludedProxies?.map((item) => ({ ...item }))
  }
}

function isSystemProxyName(name: string): boolean {
  return ['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS'].includes(name.toUpperCase())
}

function providerName(proxy: IMihomoProxy | IMihomoGroup): string | undefined {
  return 'provider-name' in proxy ? proxy['provider-name'] : undefined
}

function toCandidateProxy(
  proxy: IMihomoProxy | IMihomoGroup
): AutoSwitchCandidateProxy | undefined {
  if (!proxy.name || isSystemProxyName(proxy.name)) return undefined
  return {
    name: proxy.name,
    provider: providerName(proxy)
  }
}

function delayEntryFromResult(
  result: IMihomoDelay | undefined,
  maxDelayMs: number,
  time: string,
  error?: string
): IProxyAutoSwitchDelayEntry {
  const delay = result?.delay ?? 0
  return {
    delay,
    time,
    alive: isDelayUsable(delay, maxDelayMs),
    ...(error ? { error } : {})
  }
}

function isDelayCacheFresh(
  entry: IProxyAutoSwitchDelayEntry | undefined,
  now: Date,
  ttlMs: number
): boolean {
  if (!entry) return false
  const checkedAt = Date.parse(entry.time)
  if (!Number.isFinite(checkedAt)) return false
  return now.getTime() - checkedAt <= ttlMs
}

async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  const pending = [...items]
  const workers = Array.from({ length: Math.min(limit, pending.length) }, async () => {
    while (pending.length > 0) {
      const item = pending.shift()
      if (!item) continue
      await worker(item)
    }
  })
  await Promise.all(workers)
}

export function createAutoProxySwitchService(deps: AutoProxySwitchDeps): {
  getState: () => IProxyAutoSwitchState
  start: () => Promise<IProxyAutoSwitchState>
  stop: () => IProxyAutoSwitchState
  restart: () => Promise<IProxyAutoSwitchState>
  runCheck: (reason?: AutoProxySwitchCheckReason) => Promise<IProxyAutoSwitchState>
  recordRecovery: (action: ProxyAutoSwitchRecoveryAction, at?: Date) => IProxyAutoSwitchState
} {
  let state = initialState()
  let activeTimer: AutoSwitchTimer | undefined
  let standbyTimer: AutoSwitchTimer | undefined
  let checkingActive = false
  let checkingStandby = false
  let timerGeneration = 0
  const now = deps.now ?? (() => new Date())
  const setTimer = deps.setTimer ?? setTimeout
  const clearTimer = deps.clearTimer ?? clearTimeout

  function publish(patch?: Partial<IProxyAutoSwitchState>): IProxyAutoSwitchState {
    if (patch) state = { ...state, ...patch }
    const snapshot = cloneState(state)
    deps.notify?.(snapshot)
    return snapshot
  }

  function stopTimers(): void {
    if (activeTimer) {
      clearTimer(activeTimer)
      activeTimer = undefined
    }
    if (standbyTimer) {
      clearTimer(standbyTimer)
      standbyTimer = undefined
    }
  }

  async function config(): Promise<IProxyAutoSwitchConfig> {
    const appConfig = await deps.getAppConfig()
    return normalizeAutoSwitchConfig(appConfig.proxyAutoSwitch)
  }

  async function loadTargetGroupContext(
    configValue: IProxyAutoSwitchConfig
  ): Promise<TargetGroupContext | undefined> {
    if (!configValue.targetGroup) {
      publish({ running: configValue.enabled, paused: true, lastError: '未选择目标代理组' })
      return undefined
    }

    const groups = await deps.mihomoGroups(true)
    const group = groups.find((item) => item.name === configValue.targetGroup)
    if (!group) {
      publish({
        running: configValue.enabled,
        paused: true,
        currentGroup: configValue.targetGroup,
        lastError: '目标代理组不存在'
      })
      return undefined
    }

    const rawCandidates = group.all
      .map(toCandidateProxy)
      .filter(Boolean) as AutoSwitchCandidateProxy[]
    const bucketResult = buildRegionBuckets(
      rawCandidates,
      configValue.regions,
      configValue.excludePatterns
    )
    const candidates = bucketResult.candidates
    const current = candidates.find((candidate) => candidate.name === group.now) ??
      rawCandidates.find((candidate) => candidate.name === group.now) ?? { name: group.now }
    const currentRegion = classifyProxyRegion(current.name, configValue.regions)

    publish({
      running: configValue.enabled,
      paused: false,
      currentGroup: group.name,
      currentProxy: current.name,
      currentRegion: currentRegion?.name,
      buckets: bucketResult.buckets,
      unknownProxies: bucketResult.unknownProxies,
      excludedProxies: bucketResult.excludedProxies,
      lastError: undefined
    })

    return {
      group,
      current: {
        ...current,
        regionId: current.regionId ?? currentRegion?.id
      },
      currentRegion,
      candidates
    }
  }

  async function checkOneProxy(
    proxy: AutoSwitchCandidateProxy,
    maxDelayMs: number,
    testUrl?: string,
    retryTimeoutOnce = false
  ): Promise<IProxyAutoSwitchDelayEntry> {
    const first = await checkOneProxyOnce(proxy, maxDelayMs, testUrl)
    let finalEntry = first

    if ((first.delay <= 0 || first.error) && retryTimeoutOnce) {
      // 后台候选节点测速偶发 timeout/0ms 往往来自网络瞬时抖动或并发压测，
      // 不一定代表节点真实不可用。已返回明确高延迟的节点不重试，避免慢节点放大后台压力。
      finalEntry = await checkOneProxyOnce(proxy, maxDelayMs, testUrl)
    }

    state = {
      ...state,
      lastDelays: { ...state.lastDelays, [proxy.name]: finalEntry }
    }
    return finalEntry
  }

  async function checkOneProxyOnce(
    proxy: AutoSwitchCandidateProxy,
    maxDelayMs: number,
    testUrl?: string
  ): Promise<IProxyAutoSwitchDelayEntry> {
    const time = now().toISOString()
    try {
      const result = await deps.mihomoProxyDelay(proxy.name, testUrl, proxy.provider)
      return delayEntryFromResult(result, maxDelayMs, time)
    } catch (error) {
      return delayEntryFromResult(undefined, maxDelayMs, time, `${error}`)
    }
  }

  async function checkCandidatesWithLimit(
    configValue: IProxyAutoSwitchConfig,
    candidates: AutoSwitchCandidateProxy[],
    testUrl?: string
  ): Promise<void> {
    // 自动切换是后台故障判断，和用户手动“全量测速”的吞吐目标不同。
    // 使用独立的小并发可减少 #1507 类高并发误超时，避免把可用节点误判为不可用。
    const concurrency = Math.min(Math.max(configValue.delayConcurrency, 1), 20)
    await runWithConcurrency(candidates, concurrency, async (candidate) => {
      await checkOneProxy(candidate, configValue.maxDelayMs, testUrl, configValue.retryTimeoutOnce)
    })
  }

  function markActiveResult(
    configValue: IProxyAutoSwitchConfig,
    proxy: AutoSwitchCandidateProxy,
    entry: IProxyAutoSwitchDelayEntry
  ): boolean {
    const previousFailures = state.consecutiveFailures[proxy.name] ?? 0
    const nextFailures = entry.alive ? 0 : previousFailures + 1
    state = {
      ...state,
      consecutiveFailures: {
        ...state.consecutiveFailures,
        [proxy.name]: nextFailures
      },
      lastActiveCheckAt: entry.time
    }
    return nextFailures >= configValue.failureThreshold
  }

  function inCooldown(configValue: IProxyAutoSwitchConfig): boolean {
    if (!state.lastSwitchAt) return false
    const lastSwitchAt = Date.parse(state.lastSwitchAt)
    if (!Number.isFinite(lastSwitchAt)) return false
    return now().getTime() - lastSwitchAt < configValue.switchCooldownSec * 1000
  }

  function orderedRegionsForSwitch(
    configValue: IProxyAutoSwitchConfig,
    currentRegionId?: string
  ): IProxyAutoSwitchRegion[] {
    const enabled = configValue.regions.filter((region) => region.enabled)
    if (!currentRegionId) return enabled
    const current = enabled.find((region) => region.id === currentRegionId)
    if (!current) return enabled
    return [current, ...enabled.filter((region) => region.id !== currentRegionId)]
  }

  async function switchToBestCandidate(
    configValue: IProxyAutoSwitchConfig,
    context: TargetGroupContext
  ): Promise<void> {
    if (inCooldown(configValue)) {
      publish({ lastError: '切换冷却中' })
      return
    }

    const orderedRegions = orderedRegionsForSwitch(configValue, context.current.regionId)
    const freshnessMs = configValue.standbyIntervalSec * 2 * 1000

    for (const region of orderedRegions) {
      const regionCandidates = context.candidates.filter(
        (candidate) => candidate.regionId === region.id && candidate.name !== context.current.name
      )
      if (regionCandidates.length === 0) continue

      const needsRefresh = regionCandidates.some(
        (candidate) => !isDelayCacheFresh(state.lastDelays[candidate.name], now(), freshnessMs)
      )
      if (needsRefresh) {
        await checkCandidatesWithLimit(configValue, regionCandidates, context.group.testUrl)
      }

      const selected = chooseBestCandidate(
        regionCandidates,
        { ...configValue, regions: [region] },
        state.lastDelays,
        context.current.name
      )
      if (!selected) continue

      await deps.mihomoChangeProxy(configValue.targetGroup || context.group.name, selected.name)
      if (configValue.closeConnectionsOnSwitch) {
        await deps.mihomoCloseAllConnections()
      }

      publish({
        currentProxy: selected.name,
        currentRegion: region.name,
        lastSwitchAt: now().toISOString(),
        lastSwitchReason: `${context.current.name} 连续失败，切换到 ${selected.name}`,
        consecutiveFailures: {
          ...state.consecutiveFailures,
          [selected.name]: 0
        },
        lastError: undefined
      })
      return
    }

    publish({ lastError: '没有可用候选节点' })
  }

  async function runActiveCheck(
    configValue: IProxyAutoSwitchConfig
  ): Promise<IProxyAutoSwitchState> {
    if (checkingActive) return cloneState(state)
    checkingActive = true
    publish({ checkingActive: true })

    try {
      const context = await loadTargetGroupContext(configValue)
      if (!context) return cloneState(state)

      const entry = await checkOneProxy(
        context.current,
        configValue.maxDelayMs,
        context.group.testUrl,
        // 当前正在使用的节点是故障转移触发器：这里不重试，避免一次 active 检查
        // 被额外 timeout 拉长。误判风险由 consecutive failure threshold 吸收。
        false
      )
      const shouldSwitch = markActiveResult(configValue, context.current, entry)
      if (shouldSwitch) await switchToBestCandidate(configValue, context)
      return publish({ lastActiveCheckAt: entry.time })
    } finally {
      checkingActive = false
      publish({ checkingActive: false })
    }
  }

  async function runStandbyCheck(
    configValue: IProxyAutoSwitchConfig
  ): Promise<IProxyAutoSwitchState> {
    if (checkingStandby || checkingActive) return cloneState(state)
    checkingStandby = true
    publish({ checkingStandby: true })

    try {
      const context = await loadTargetGroupContext(configValue)
      if (!context) return cloneState(state)
      await checkCandidatesWithLimit(configValue, context.candidates, context.group.testUrl)
      return publish({ lastStandbyCheckAt: now().toISOString() })
    } finally {
      checkingStandby = false
      publish({ checkingStandby: false })
    }
  }

  function scheduleActive(configValue: IProxyAutoSwitchConfig, generation = timerGeneration): void {
    activeTimer = setTimer(() => {
      void runActiveCheck(configValue).finally(() => {
        // restart() 会 stop 后立刻 start。旧检查完成时如果只看 state.running，
        // 会把旧 timer 链接到新运行周期，造成重复调度。generation 用来隔离运行周期。
        if (state.running && generation === timerGeneration) scheduleActive(configValue, generation)
      })
    }, configValue.activeIntervalSec * 1000)
    publish({
      nextActiveCheckAt: new Date(
        now().getTime() + configValue.activeIntervalSec * 1000
      ).toISOString()
    })
  }

  function scheduleStandby(
    configValue: IProxyAutoSwitchConfig,
    generation = timerGeneration
  ): void {
    standbyTimer = setTimer(() => {
      void runStandbyCheck(configValue).finally(() => {
        if (state.running && generation === timerGeneration) {
          scheduleStandby(configValue, generation)
        }
      })
    }, configValue.standbyIntervalSec * 1000)
    publish({
      nextStandbyCheckAt: new Date(
        now().getTime() + configValue.standbyIntervalSec * 1000
      ).toISOString()
    })
  }

  async function start(): Promise<IProxyAutoSwitchState> {
    timerGeneration += 1
    stopTimers()
    const configValue = await config()
    if (!configValue.enabled) {
      state = {
        ...initialState(),
        running: false,
        paused: false,
        lastError: undefined
      }
      return publish()
    }

    publish({ running: true, paused: false, lastError: undefined })
    const generation = timerGeneration
    scheduleActive(configValue, generation)
    scheduleStandby(configValue, generation)
    return cloneState(state)
  }

  function stop(): IProxyAutoSwitchState {
    timerGeneration += 1
    stopTimers()
    checkingActive = false
    checkingStandby = false
    state = {
      ...state,
      running: false,
      checkingActive: false,
      checkingStandby: false,
      nextActiveCheckAt: undefined,
      nextStandbyCheckAt: undefined
    }
    return publish()
  }

  async function runCheck(
    reason: AutoProxySwitchCheckReason = 'manual'
  ): Promise<IProxyAutoSwitchState> {
    const configValue = await config()
    if (reason === 'manual') return await runStandbyCheck(configValue)
    if (!configValue.enabled) {
      return publish({ running: false, paused: false, lastError: undefined })
    }
    if (reason === 'standby') return await runStandbyCheck(configValue)
    return await runActiveCheck(configValue)
  }

  return {
    getState: () => cloneState(state),
    start,
    stop,
    restart: async () => {
      stop()
      return await start()
    },
    runCheck,
    recordRecovery: (action: ProxyAutoSwitchRecoveryAction, at = now()) =>
      publish({
        lastRecoveryAt: at.toISOString(),
        lastRecoveryAction: action
      })
  }
}

const service = createAutoProxySwitchService({
  getAppConfig,
  mihomoGroups,
  mihomoProxyDelay,
  mihomoChangeProxy,
  mihomoCloseAllConnections,
  notify: (nextState) => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    mainWindow.webContents.send('autoProxySwitchUpdated', nextState)
  }
})

export function getAutoProxySwitchState(): IProxyAutoSwitchState {
  return service.getState()
}

export async function startAutoProxySwitch(): Promise<IProxyAutoSwitchState> {
  return await service.start()
}

export function stopAutoProxySwitch(): IProxyAutoSwitchState {
  return service.stop()
}

export async function restartAutoProxySwitch(): Promise<IProxyAutoSwitchState> {
  return await service.restart()
}

export async function runAutoProxySwitchCheck(
  reason: AutoProxySwitchCheckReason = 'manual'
): Promise<IProxyAutoSwitchState> {
  return await service.runCheck(reason)
}

export function recordAutoProxySwitchRecovery(
  action: ProxyAutoSwitchRecoveryAction
): IProxyAutoSwitchState {
  return service.recordRecovery(action)
}
