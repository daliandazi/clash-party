/* eslint-disable import/order */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const singletonMocks = vi.hoisted(() => ({
  getAppConfig: vi.fn(),
  mihomoGroups: vi.fn(),
  mihomoProxyDelay: vi.fn(),
  mihomoChangeProxy: vi.fn(),
  mihomoCloseAllConnections: vi.fn(),
  send: vi.fn()
}))

vi.mock('../config', () => ({
  getAppConfig: singletonMocks.getAppConfig
}))

vi.mock('../window', () => ({
  mainWindow: { webContents: { send: singletonMocks.send } }
}))

vi.mock('./mihomoApi', () => ({
  mihomoGroups: singletonMocks.mihomoGroups,
  mihomoProxyDelay: singletonMocks.mihomoProxyDelay,
  mihomoChangeProxy: singletonMocks.mihomoChangeProxy,
  mihomoCloseAllConnections: singletonMocks.mihomoCloseAllConnections
}))

import {
  buildRegionBuckets,
  chooseBestCandidate,
  classifyProxyRegion,
  createAutoProxySwitchService,
  isDelayUsable,
  normalizeAutoSwitchConfig
} from './autoProxySwitch'

describe('autoProxySwitch pure functions', () => {
  const config = normalizeAutoSwitchConfig({
    enabled: true,
    targetGroup: 'PROXY',
    activeIntervalSec: 15,
    standbyIntervalSec: 300,
    switchCooldownSec: 180,
    maxDelayMs: 800,
    failureThreshold: 2,
    closeConnectionsOnSwitch: true,
    regions: [
      { id: 'us', name: '美国', patterns: ['US', '美国'], enabled: true },
      { id: 'jp', name: '日本', patterns: ['/JP|日本/i'], enabled: true }
    ]
  })

  it('normalizes missing values and clamps unsafe intervals', () => {
    const value = normalizeAutoSwitchConfig({ activeIntervalSec: 1, failureThreshold: 0 })

    expect(value.activeIntervalSec).toBe(5)
    expect(value.standbyIntervalSec).toBe(300)
    expect(value.failureThreshold).toBe(1)
    expect(value.regions.length).toBeGreaterThan(0)
  })

  it('normalizes recovery probing options and excluded proxy patterns', () => {
    const value = normalizeAutoSwitchConfig({
      delayConcurrency: 99,
      retryTimeoutOnce: false,
      excludePatterns: [' HK ', '', '/倍率/i']
    })

    expect(value.delayConcurrency).toBe(20)
    expect(value.retryTimeoutOnce).toBe(false)
    expect(value.excludePatterns).toEqual(['HK', '/倍率/i'])
  })

  it('normalizes invalid region entries without throwing', () => {
    const value = normalizeAutoSwitchConfig({
      regions: [
        null,
        {},
        { id: 'custom', patterns: [' US ', ''] }
      ] as unknown as IProxyAutoSwitchRegion[]
    })

    expect(value.regions).toEqual([
      { id: 'custom', name: 'custom', patterns: ['US'], enabled: true }
    ])
  })

  it('classifies proxy by keyword using region priority', () => {
    expect(classifyProxyRegion('US-01 日本备份', config.regions)?.id).toBe('us')
  })

  it('classifies proxy by slash regex', () => {
    expect(classifyProxyRegion('JP Tokyo 01', config.regions)?.id).toBe('jp')
  })

  it('ignores invalid slash regex patterns', () => {
    expect(
      classifyProxyRegion('US-01', [
        { id: 'broken', name: '坏规则', patterns: ['/[abc/'], enabled: true },
        { id: 'us', name: '美国', patterns: ['US'], enabled: true }
      ])?.id
    ).toBe('us')
  })

  it('rejects timeout and over-threshold delays', () => {
    expect(isDelayUsable(undefined, 800)).toBe(false)
    expect(isDelayUsable(0, 800)).toBe(false)
    expect(isDelayUsable(801, 800)).toBe(false)
    expect(isDelayUsable(120, 800)).toBe(true)
  })

  it('builds buckets and keeps provider information', () => {
    const result = buildRegionBuckets(
      [{ name: 'US-01', provider: 'provider-a' }, { name: 'JP-01' }, { name: 'Premium-01' }],
      config.regions
    )

    expect(result.candidates.find((item) => item.name === 'US-01')?.provider).toBe('provider-a')
    expect(result.buckets.find((item) => item.id === 'us')?.proxies).toContain('US-01')
    expect(result.unknownProxies).toEqual(['Premium-01'])
  })

  it('excludes proxies before region bucketing', () => {
    const result = buildRegionBuckets(
      [{ name: 'US-01' }, { name: 'US-HK-relay' }, { name: 'JP-5x' }],
      config.regions,
      ['HK', '/5x/i']
    )

    expect(result.candidates.map((item) => item.name)).toEqual(['US-01'])
    expect(result.excludedProxies).toEqual([
      { name: 'US-HK-relay', pattern: 'HK' },
      { name: 'JP-5x', pattern: '/5x/i' }
    ])
  })

  it('ignores invalid exclusion regex without excluding everything', () => {
    const result = buildRegionBuckets([{ name: 'US-01' }], config.regions, ['/[abc/'])

    expect(result.candidates.map((item) => item.name)).toEqual(['US-01'])
    expect(result.excludedProxies).toEqual([])
  })

  it('chooses the lowest delay in the highest-priority usable region', () => {
    const selected = chooseBestCandidate(
      [
        { name: 'US-01', regionId: 'us' },
        { name: 'US-02', regionId: 'us' },
        { name: 'JP-01', regionId: 'jp' }
      ],
      config,
      {
        'US-01': { delay: 900, time: new Date().toISOString(), alive: false },
        'US-02': { delay: 100, time: new Date().toISOString(), alive: true },
        'JP-01': { delay: 50, time: new Date().toISOString(), alive: true }
      }
    )

    expect(selected?.name).toBe('US-02')
  })

  it('falls back to next region when preferred region is unusable', () => {
    const selected = chooseBestCandidate(
      [
        { name: 'US-01', regionId: 'us' },
        { name: 'JP-01', regionId: 'jp' }
      ],
      config,
      {
        'US-01': { delay: 900, time: new Date().toISOString(), alive: false },
        'JP-01': { delay: 120, time: new Date().toISOString(), alive: true }
      }
    )

    expect(selected?.name).toBe('JP-01')
  })

  it('does not choose the current proxy again', () => {
    const selected = chooseBestCandidate(
      [
        { name: 'US-01', regionId: 'us' },
        { name: 'US-02', regionId: 'us' }
      ],
      config,
      {
        'US-01': { delay: 10, time: new Date().toISOString(), alive: true },
        'US-02': { delay: 100, time: new Date().toISOString(), alive: true }
      },
      'US-01'
    )

    expect(selected?.name).toBe('US-02')
  })
})

function proxy(name: string, provider?: string): IMihomoProxy {
  return {
    alive: true,
    extra: {},
    history: [],
    id: name,
    name,
    tfo: false,
    type: 'Shadowsocks',
    udp: true,
    uot: false,
    xudp: false,
    mptcp: false,
    smux: false,
    ...(provider ? { 'provider-name': provider } : {})
  }
}

function group(now: string, all: IMihomoProxy[]): IMihomoMixedGroup {
  return {
    alive: true,
    all,
    extra: {},
    hidden: false,
    history: [],
    icon: '',
    name: 'PROXY',
    now,
    testUrl: 'https://group.example/generate_204',
    tfo: false,
    type: 'Selector',
    udp: true,
    xudp: false
  }
}

describe('autoProxySwitch service decisions', () => {
  const baseConfig: IProxyAutoSwitchConfig = {
    enabled: true,
    targetGroup: 'PROXY',
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
      { id: 'us', name: '美国', patterns: ['US'], enabled: true },
      { id: 'jp', name: '日本', patterns: ['JP'], enabled: true }
    ]
  }

  const deps = {
    getAppConfig: vi.fn(),
    mihomoGroups: vi.fn(),
    mihomoProxyDelay: vi.fn(),
    mihomoChangeProxy: vi.fn(),
    mihomoCloseAllConnections: vi.fn(),
    notify: vi.fn(),
    now: vi.fn()
  }

  beforeEach(() => {
    vi.clearAllMocks()
    deps.getAppConfig.mockResolvedValue({
      proxyAutoSwitch: baseConfig,
      delayTestConcurrency: 50
    })
    deps.mihomoGroups.mockResolvedValue([
      group('US-01', [proxy('US-01'), proxy('US-02', 'provider-a'), proxy('JP-01')])
    ])
    deps.mihomoChangeProxy.mockResolvedValue(proxy('US-02'))
    deps.mihomoCloseAllConnections.mockResolvedValue(undefined)
    deps.now.mockReturnValue(new Date('2026-08-27T00:00:00.000Z'))
  })

  it('switches to a lower-latency proxy in the same region after consecutive active failures', async () => {
    deps.mihomoProxyDelay.mockImplementation(async (name: string) => {
      if (name === 'US-01') return { delay: 1200 }
      if (name === 'US-02') return { delay: 100 }
      if (name === 'JP-01') return { delay: 50 }
      return { delay: 0 }
    })
    const service = createAutoProxySwitchService(deps)

    await service.runCheck('active')
    await service.runCheck('active')

    expect(deps.mihomoChangeProxy).toHaveBeenCalledWith('PROXY', 'US-02')
    expect(deps.mihomoCloseAllConnections).toHaveBeenCalledOnce()
    expect(deps.mihomoProxyDelay).toHaveBeenCalledWith(
      'US-02',
      'https://group.example/generate_204',
      'provider-a'
    )
  })

  it('falls back to the next configured region when current region has no usable proxy', async () => {
    deps.mihomoProxyDelay.mockImplementation(async (name: string) => {
      if (name === 'US-01') return { delay: 1200 }
      if (name === 'US-02') return { delay: 0 }
      if (name === 'JP-01') return { delay: 120 }
      return { delay: 0 }
    })
    const service = createAutoProxySwitchService(deps)

    await service.runCheck('active')
    await service.runCheck('active')

    expect(deps.mihomoChangeProxy).toHaveBeenCalledWith('PROXY', 'JP-01')
  })

  it('retries a timed-out candidate once before deciding it is unusable', async () => {
    deps.getAppConfig.mockResolvedValue({
      proxyAutoSwitch: { ...baseConfig, retryTimeoutOnce: true, delayConcurrency: 4 },
      delayTestConcurrency: 50
    })
    deps.mihomoProxyDelay.mockImplementation(async (name: string) => {
      if (name === 'US-01') return { delay: 1200 }
      if (name === 'US-02') {
        const attempts = deps.mihomoProxyDelay.mock.calls.filter(
          ([proxyName]) => proxyName === 'US-02'
        )
        return { delay: attempts.length === 1 ? 0 : 100 }
      }
      return { delay: 0 }
    })
    const service = createAutoProxySwitchService(deps)

    await service.runCheck('active')
    await service.runCheck('active')

    expect(deps.mihomoChangeProxy).toHaveBeenCalledWith('PROXY', 'US-02')
  })

  it('does not retry the active proxy health check so failover is not delayed', async () => {
    deps.getAppConfig.mockResolvedValue({
      proxyAutoSwitch: { ...baseConfig, failureThreshold: 1, retryTimeoutOnce: true },
      delayTestConcurrency: 50
    })
    deps.mihomoProxyDelay.mockImplementation(async (name: string) => {
      if (name === 'US-01') {
        const attempts = deps.mihomoProxyDelay.mock.calls.filter(
          ([proxyName]) => proxyName === 'US-01'
        )
        return { delay: attempts.length === 1 ? 0 : 100 }
      }
      if (name === 'US-02') return { delay: 100 }
      return { delay: 0 }
    })
    const service = createAutoProxySwitchService(deps)

    await service.runCheck('active')

    expect(deps.mihomoChangeProxy).toHaveBeenCalledWith('PROXY', 'US-02')
    expect(deps.mihomoProxyDelay.mock.calls.filter(([name]) => name === 'US-01')).toHaveLength(1)
  })

  it('does not retry candidates when retryTimeoutOnce is disabled', async () => {
    deps.getAppConfig.mockResolvedValue({
      proxyAutoSwitch: { ...baseConfig, failureThreshold: 1, retryTimeoutOnce: false },
      delayTestConcurrency: 50
    })
    deps.mihomoProxyDelay.mockImplementation(async (name: string) => {
      if (name === 'US-01') return { delay: 1200 }
      if (name === 'US-02') {
        const attempts = deps.mihomoProxyDelay.mock.calls.filter(
          ([proxyName]) => proxyName === 'US-02'
        )
        return { delay: attempts.length === 1 ? 0 : 100 }
      }
      return { delay: 0 }
    })
    const service = createAutoProxySwitchService(deps)

    await service.runCheck('active')

    expect(deps.mihomoChangeProxy).not.toHaveBeenCalled()
    expect(deps.mihomoProxyDelay.mock.calls.filter(([name]) => name === 'US-02')).toHaveLength(1)
  })

  it('does not retry candidates that responded above the delay threshold', async () => {
    deps.getAppConfig.mockResolvedValue({
      proxyAutoSwitch: { ...baseConfig, failureThreshold: 1, retryTimeoutOnce: true },
      delayTestConcurrency: 50
    })
    deps.mihomoProxyDelay.mockImplementation(async (name: string) => {
      if (name === 'US-01') return { delay: 1200 }
      if (name === 'US-02') return { delay: 1200 }
      return { delay: 0 }
    })
    const service = createAutoProxySwitchService(deps)

    await service.runCheck('active')

    expect(deps.mihomoChangeProxy).not.toHaveBeenCalled()
    expect(deps.mihomoProxyDelay.mock.calls.filter(([name]) => name === 'US-02')).toHaveLength(1)
  })

  it('uses auto-switch delayConcurrency instead of global manual delay concurrency', async () => {
    deps.getAppConfig.mockResolvedValue({
      proxyAutoSwitch: { ...baseConfig, delayConcurrency: 1 },
      delayTestConcurrency: 50
    })
    deps.mihomoGroups.mockResolvedValue([
      group('US-01', [proxy('US-01'), proxy('US-02'), proxy('JP-01')])
    ])
    let inFlight = 0
    let maxInFlight = 0
    deps.mihomoProxyDelay.mockImplementation(async () => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 5))
      inFlight -= 1
      return { delay: 100 }
    })
    const service = createAutoProxySwitchService(deps)

    await service.runCheck('standby')

    expect(deps.mihomoProxyDelay).toHaveBeenCalledTimes(3)
    expect(maxInFlight).toBe(1)
  })

  it('does not switch while in cooldown', async () => {
    deps.mihomoProxyDelay.mockImplementation(async (name: string) => {
      if (name === 'US-01') return { delay: 1200 }
      if (name === 'US-02') return { delay: 100 }
      return { delay: 0 }
    })
    const service = createAutoProxySwitchService(deps)

    await service.runCheck('active')
    await service.runCheck('active')
    deps.mihomoChangeProxy.mockClear()
    await service.runCheck('active')
    await service.runCheck('active')

    expect(deps.mihomoChangeProxy).not.toHaveBeenCalled()
  })

  it('standby refreshes delay cache without switching', async () => {
    deps.mihomoProxyDelay.mockResolvedValue({ delay: 100 })
    const service = createAutoProxySwitchService(deps)

    const state = await service.runCheck('standby')

    expect(deps.mihomoProxyDelay).toHaveBeenCalledWith(
      'US-02',
      'https://group.example/generate_204',
      'provider-a'
    )
    expect(deps.mihomoChangeProxy).not.toHaveBeenCalled()
    expect(state.lastDelays['US-02']?.alive).toBe(true)
  })

  it('manual check refreshes target group delays even when auto switch is disabled', async () => {
    deps.getAppConfig.mockResolvedValue({
      proxyAutoSwitch: { ...baseConfig, enabled: false },
      delayTestConcurrency: 50
    })
    deps.mihomoProxyDelay.mockImplementation(async (name: string) => {
      if (name === 'US-01') return { delay: 1200 }
      if (name === 'US-02') return { delay: 100 }
      if (name === 'JP-01') return { delay: 80 }
      return { delay: 0 }
    })
    const service = createAutoProxySwitchService(deps)

    const state = await service.runCheck('manual')

    expect(deps.mihomoProxyDelay).toHaveBeenCalledWith(
      'US-01',
      'https://group.example/generate_204',
      undefined
    )
    expect(deps.mihomoProxyDelay).toHaveBeenCalledWith(
      'US-02',
      'https://group.example/generate_204',
      'provider-a'
    )
    expect(deps.mihomoProxyDelay).toHaveBeenCalledWith(
      'JP-01',
      'https://group.example/generate_204',
      undefined
    )
    expect(deps.mihomoChangeProxy).not.toHaveBeenCalled()
    expect(state.running).toBe(false)
    expect(state.lastDelays['US-02']?.delay).toBe(100)
    expect(state.lastDelays['JP-01']?.delay).toBe(80)
  })

  it('does not reschedule timers after stop while a check is still running', async () => {
    let resolveDelay: (value: IMihomoDelay) => void = () => {}
    const setTimer = vi.fn((handler: () => void) => {
      return handler
    })
    const clearTimer = vi.fn()
    deps.mihomoProxyDelay.mockReturnValue(
      new Promise<IMihomoDelay>((resolve) => {
        resolveDelay = resolve
      })
    )
    const service = createAutoProxySwitchService({ ...deps, setTimer, clearTimer })

    await service.start()
    const activeHandler = setTimer.mock.calls[0][0]
    setTimer.mockClear()
    activeHandler()
    await Promise.resolve()
    await Promise.resolve()
    service.stop()
    resolveDelay({ delay: 100 })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(setTimer).not.toHaveBeenCalled()
  })

  it('does not let an old active timer reschedule after restart', async () => {
    let resolveDelay: (value: IMihomoDelay) => void = () => {}
    const setTimer = vi.fn((handler: () => void) => {
      return handler
    })
    const clearTimer = vi.fn()
    deps.mihomoProxyDelay.mockReturnValue(
      new Promise<IMihomoDelay>((resolve) => {
        resolveDelay = resolve
      })
    )
    const service = createAutoProxySwitchService({ ...deps, setTimer, clearTimer })

    await service.start()
    const oldActiveHandler = setTimer.mock.calls[0][0]
    oldActiveHandler()
    await Promise.resolve()
    await Promise.resolve()
    setTimer.mockClear()
    await service.restart()
    const timersScheduledByRestart = setTimer.mock.calls.length

    resolveDelay({ delay: 100 })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(setTimer).toHaveBeenCalledTimes(timersScheduledByRestart)
  })
})
