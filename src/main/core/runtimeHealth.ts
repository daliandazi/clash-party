import { getAppConfig } from '../config'
import { createLogger } from '../utils/logger'
import {
  getAutoProxySwitchState,
  recordAutoProxySwitchRecovery,
  runAutoProxySwitchCheck
} from './autoProxySwitch'
import { hasCoreProcess, restartCore } from './manager'

type RuntimeHealthTimer = ReturnType<typeof setTimeout> | number

type RuntimeHealthLogValue = Record<string, unknown>

interface RuntimeHealthDeps {
  runAutoProxySwitchCheck: (reason: 'active') => Promise<Partial<IProxyAutoSwitchState>>
  restartCore: (forceStop?: boolean) => Promise<void>
  hasCoreProcess: () => boolean
  getAutoProxySwitchState: () => IProxyAutoSwitchState
  recordAutoProxySwitchRecovery: (
    action: ProxyAutoSwitchRecoveryAction
  ) => IProxyAutoSwitchState | void
  getAppConfig: () => Promise<Partial<IAppConfig>>
  logInfo: (message: string, value?: RuntimeHealthLogValue) => Promise<void> | void
  logWarn: (message: string, value?: unknown) => Promise<void> | void
  now?: () => Date
  setTimer?: (handler: () => void, timeout: number) => RuntimeHealthTimer
  clearTimer?: (timer: RuntimeHealthTimer) => void
  memoryUsage?: () => NodeJS.MemoryUsage
  resumeDelayMs?: number
  resumeCooldownMs?: number
}

export interface RuntimeHealthService {
  handleResume: () => Promise<void>
  startDiagnostics: () => Promise<void>
  stopDiagnostics: () => void
}

const DEFAULT_RESUME_DELAY_MS = 5000
const DEFAULT_RESUME_COOLDOWN_MS = 60_000
const DEFAULT_DIAGNOSTICS_CONFIG: IRuntimeDiagnosticsConfig = {
  enabled: true,
  intervalSec: 300,
  logMemory: true,
  logCoreState: true
}

const RECOVERABLE_AUTO_SWITCH_ERRORS = new Set([
  '没有可用候选节点',
  '目标代理组不存在',
  '未选择目标代理组'
])
const runtimeHealthLogger = createLogger('runtime-health')

function clampDiagnosticsInterval(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_DIAGNOSTICS_CONFIG.intervalSec
  }
  return Math.max(Math.floor(value), 30)
}

function normalizeDiagnosticsConfig(
  value?: Partial<IRuntimeDiagnosticsConfig>
): IRuntimeDiagnosticsConfig {
  return {
    enabled: value?.enabled !== false,
    intervalSec: clampDiagnosticsInterval(value?.intervalSec),
    logMemory: value?.logMemory !== false,
    logCoreState: value?.logCoreState !== false
  }
}

function sleepWithTimer(
  setTimer: NonNullable<RuntimeHealthDeps['setTimer']>,
  timeout: number
): Promise<void> {
  if (timeout <= 0) return Promise.resolve()
  return new Promise((resolve) => {
    setTimer(resolve, timeout)
  })
}

function summarizeAutoSwitchState(state: IProxyAutoSwitchState): RuntimeHealthLogValue {
  return {
    running: state.running,
    paused: state.paused,
    checkingActive: state.checkingActive,
    checkingStandby: state.checkingStandby,
    currentGroup: state.currentGroup,
    currentProxy: state.currentProxy,
    currentRegion: state.currentRegion,
    consecutiveFailureProxies: Object.keys(state.consecutiveFailures).length,
    lastError: state.lastError
  }
}

function summarizeMemory(memory: NodeJS.MemoryUsage): RuntimeHealthLogValue {
  return {
    rss: memory.rss,
    heapTotal: memory.heapTotal,
    heapUsed: memory.heapUsed,
    external: memory.external,
    arrayBuffers: memory.arrayBuffers
  }
}

export function createRuntimeHealthService(deps: RuntimeHealthDeps): RuntimeHealthService {
  const now = deps.now ?? (() => new Date())
  const setTimer = deps.setTimer ?? setTimeout
  const clearTimer = deps.clearTimer ?? clearTimeout
  const memoryUsage = deps.memoryUsage ?? process.memoryUsage.bind(process)
  const resumeDelayMs = deps.resumeDelayMs ?? DEFAULT_RESUME_DELAY_MS
  const resumeCooldownMs = deps.resumeCooldownMs ?? DEFAULT_RESUME_COOLDOWN_MS

  let lastResumeRecoveryAt = 0
  let diagnosticsTimer: RuntimeHealthTimer | undefined
  let diagnosticsGeneration = 0

  function cancelDiagnosticsTimer(): void {
    if (!diagnosticsTimer) return
    clearTimer(diagnosticsTimer)
    diagnosticsTimer = undefined
  }

  async function handleResume(): Promise<void> {
    const currentTime = now().getTime()
    if (currentTime - lastResumeRecoveryAt < resumeCooldownMs) {
      await deps.logInfo('Resume recovery skipped during cooldown')
      return
    }

    lastResumeRecoveryAt = currentTime
    await deps.logInfo('Runtime resume detected')
    await sleepWithTimer(setTimer, resumeDelayMs)

    try {
      const autoSwitchState = await deps.runAutoProxySwitchCheck('active')
      const shouldRestartCore =
        !deps.hasCoreProcess() ||
        (typeof autoSwitchState.lastError === 'string' &&
          RECOVERABLE_AUTO_SWITCH_ERRORS.has(autoSwitchState.lastError))

      if (shouldRestartCore) {
        // resume 后网络栈和本地 core 可能不同步。只有在自动切换无法恢复或 core 已不存在时，
        // 才强制重启 core，避免正常节点抖动时制造重启风暴。
        await deps.restartCore(true)
        deps.recordAutoProxySwitchRecovery('resume-core-restart')
        await deps.logWarn('Runtime resume recovery restarted core', {
          lastError: autoSwitchState.lastError,
          coreRunning: deps.hasCoreProcess()
        })
        return
      }

      deps.recordAutoProxySwitchRecovery('resume-check-ok')
      await deps.logInfo('Runtime resume recovery completed', {
        lastError: autoSwitchState.lastError,
        coreRunning: deps.hasCoreProcess()
      })
    } catch (error) {
      await deps.logWarn('Runtime resume recovery failed', error)
    }
  }

  async function logDiagnosticsOnce(config: IRuntimeDiagnosticsConfig): Promise<void> {
    const payload: RuntimeHealthLogValue = {
      autoSwitch: summarizeAutoSwitchState(deps.getAutoProxySwitchState())
    }

    if (config.logCoreState) payload.coreRunning = deps.hasCoreProcess()
    if (config.logMemory) payload.memory = summarizeMemory(memoryUsage())

    await deps.logInfo('Runtime diagnostics', payload)
  }

  function scheduleDiagnostics(config: IRuntimeDiagnosticsConfig, generation: number): void {
    diagnosticsTimer = setTimer(() => {
      void logDiagnosticsOnce(config).finally(() => {
        // start/stop 可能和一次诊断日志写入并发。generation 防止旧回调在 stop 或重启后
        // 重新注册一个无人持有的 timer，避免长时间运行后重复诊断任务堆积。
        if (diagnosticsTimer && generation === diagnosticsGeneration) {
          scheduleDiagnostics(config, generation)
        }
      })
    }, config.intervalSec * 1000)
  }

  async function startDiagnostics(): Promise<void> {
    const generation = diagnosticsGeneration + 1
    diagnosticsGeneration = generation
    cancelDiagnosticsTimer()
    const appConfig = await deps.getAppConfig()
    if (generation !== diagnosticsGeneration) return

    const config = normalizeDiagnosticsConfig(appConfig.runtimeDiagnostics)
    if (!config.enabled) return

    scheduleDiagnostics(config, generation)
  }

  function stopDiagnostics(): void {
    diagnosticsGeneration += 1
    cancelDiagnosticsTimer()
  }

  return {
    handleResume,
    startDiagnostics,
    stopDiagnostics
  }
}

const service = createRuntimeHealthService({
  runAutoProxySwitchCheck,
  restartCore,
  hasCoreProcess,
  getAutoProxySwitchState,
  recordAutoProxySwitchRecovery,
  getAppConfig,
  logInfo: (message, value) => runtimeHealthLogger.info(message, value),
  logWarn: (message, value) => runtimeHealthLogger.warn(message, value)
})

export async function handleRuntimeResume(): Promise<void> {
  await service.handleResume()
}

export async function startRuntimeDiagnostics(): Promise<void> {
  await service.startDiagnostics()
}

export function stopRuntimeDiagnostics(): void {
  service.stopDiagnostics()
}
