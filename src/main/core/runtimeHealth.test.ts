/* eslint-disable import/order */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const singletonMocks = vi.hoisted(() => ({
  getAppConfig: vi.fn(),
  getAutoProxySwitchState: vi.fn(),
  recordAutoProxySwitchRecovery: vi.fn(),
  runAutoProxySwitchCheck: vi.fn(),
  hasCoreProcess: vi.fn(),
  restartCore: vi.fn(),
  info: vi.fn(),
  warn: vi.fn()
}))

vi.mock('../config', () => ({
  getAppConfig: singletonMocks.getAppConfig
}))

vi.mock('../utils/logger', () => ({
  createLogger: () => ({
    info: singletonMocks.info,
    warn: singletonMocks.warn
  })
}))

vi.mock('./autoProxySwitch', () => ({
  getAutoProxySwitchState: singletonMocks.getAutoProxySwitchState,
  recordAutoProxySwitchRecovery: singletonMocks.recordAutoProxySwitchRecovery,
  runAutoProxySwitchCheck: singletonMocks.runAutoProxySwitchCheck
}))

vi.mock('./manager', () => ({
  hasCoreProcess: singletonMocks.hasCoreProcess,
  restartCore: singletonMocks.restartCore
}))

import { createRuntimeHealthService } from './runtimeHealth'

describe('runtime health service', () => {
  const deps = {
    runAutoProxySwitchCheck: vi.fn(),
    restartCore: vi.fn(),
    hasCoreProcess: vi.fn(),
    getAutoProxySwitchState: vi.fn(),
    recordAutoProxySwitchRecovery: vi.fn(),
    getAppConfig: vi.fn(),
    logInfo: vi.fn(),
    logWarn: vi.fn(),
    now: vi.fn(),
    setTimer: vi.fn(),
    clearTimer: vi.fn(),
    memoryUsage: vi.fn()
  }

  beforeEach(() => {
    vi.clearAllMocks()
    deps.now.mockReturnValue(new Date('2026-08-28T00:00:00.000Z'))
    deps.hasCoreProcess.mockReturnValue(true)
    deps.runAutoProxySwitchCheck.mockResolvedValue({ lastError: undefined })
    deps.restartCore.mockResolvedValue(undefined)
    deps.recordAutoProxySwitchRecovery.mockReturnValue(undefined)
    deps.getAutoProxySwitchState.mockReturnValue({
      running: true,
      paused: false,
      checkingActive: false,
      checkingStandby: false,
      consecutiveFailures: {},
      lastDelays: {},
      buckets: [],
      unknownProxies: [],
      excludedProxies: []
    })
    deps.getAppConfig.mockResolvedValue({
      runtimeDiagnostics: {
        enabled: true,
        intervalSec: 300,
        logMemory: true,
        logCoreState: true
      }
    })
    deps.logInfo.mockResolvedValue(undefined)
    deps.logWarn.mockResolvedValue(undefined)
    deps.setTimer.mockImplementation((handler: () => void) => {
      handler()
      return 1
    })
    deps.memoryUsage.mockReturnValue({
      rss: 100,
      heapTotal: 80,
      heapUsed: 40,
      external: 10,
      arrayBuffers: 5
    })
  })

  it('runs auto-switch recovery after resume delay', async () => {
    const service = createRuntimeHealthService({ ...deps, resumeDelayMs: 0 })

    await service.handleResume()

    expect(deps.runAutoProxySwitchCheck).toHaveBeenCalledWith('active')
    expect(deps.restartCore).not.toHaveBeenCalled()
    expect(deps.recordAutoProxySwitchRecovery).toHaveBeenCalledWith('resume-check-ok')
  })

  it('restarts core when resume recovery cannot find a usable proxy', async () => {
    deps.runAutoProxySwitchCheck.mockResolvedValue({ lastError: '没有可用候选节点' })
    const service = createRuntimeHealthService({ ...deps, resumeDelayMs: 0 })

    await service.handleResume()

    expect(deps.restartCore).toHaveBeenCalledWith(true)
    expect(deps.recordAutoProxySwitchRecovery).toHaveBeenCalledWith('resume-core-restart')
  })

  it('skips repeated resume recovery during cooldown', async () => {
    const service = createRuntimeHealthService({
      ...deps,
      resumeDelayMs: 0,
      resumeCooldownMs: 60_000
    })

    await service.handleResume()
    await service.handleResume()

    expect(deps.runAutoProxySwitchCheck).toHaveBeenCalledTimes(1)
    expect(deps.logInfo).toHaveBeenCalledWith('Resume recovery skipped during cooldown')
  })

  it('logs compact runtime diagnostics and stops scheduled diagnostics', async () => {
    let scheduledHandler: (() => void) | undefined
    deps.setTimer.mockImplementation((handler: () => void) => {
      scheduledHandler = handler
      return 42
    })
    const service = createRuntimeHealthService(deps)

    await service.startDiagnostics()
    await scheduledHandler?.()
    service.stopDiagnostics()

    expect(deps.logInfo).toHaveBeenCalledWith(
      'Runtime diagnostics',
      expect.objectContaining({
        coreRunning: true,
        memory: expect.objectContaining({ rss: 100, heapUsed: 40 }),
        autoSwitch: expect.objectContaining({ running: true, lastError: undefined })
      })
    )
    expect(deps.clearTimer).toHaveBeenCalledWith(42)
  })

  it('does not leave duplicate diagnostics timers when start is called concurrently', async () => {
    let resolveFirstConfig: (value: Partial<IAppConfig>) => void = () => {}
    const diagnosticsConfig = {
      runtimeDiagnostics: {
        enabled: true,
        intervalSec: 300,
        logMemory: true,
        logCoreState: true
      }
    }
    deps.getAppConfig
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveFirstConfig = resolve
        })
      )
      .mockResolvedValueOnce(diagnosticsConfig)
    deps.setTimer.mockReturnValue(1)
    const service = createRuntimeHealthService(deps)

    const firstStart = service.startDiagnostics()
    const secondStart = service.startDiagnostics()
    await secondStart
    resolveFirstConfig(diagnosticsConfig)
    await firstStart

    expect(deps.setTimer).toHaveBeenCalledTimes(1)
  })
})
