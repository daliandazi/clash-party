import { EventEmitter } from 'events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { PassThrough, Writable } from 'stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  testDir: '',
  spawn: vi.fn(),
  execFile: vi.fn(),
  ensureRuntimeFiles: vi.fn(),
  getAppConfig: vi.fn(),
  getControledMihomoConfig: vi.fn(),
  getProfileItem: vi.fn(),
  manageSmartOverride: vi.fn(),
  generateProfile: vi.fn(),
  cleanupSocketFile: vi.fn(),
  waitForCoreReady: vi.fn(),
  verifyProcessOwner: vi.fn(),
  getAxios: vi.fn(),
  startMihomoTraffic: vi.fn(),
  startMihomoConnections: vi.fn(),
  startMihomoLogs: vi.fn(),
  startMihomoMemory: vi.fn(),
  stopMihomoTraffic: vi.fn(),
  stopMihomoConnections: vi.fn(),
  stopMihomoLogs: vi.fn(),
  stopMihomoMemory: vi.fn(),
  patchMihomoConfig: vi.fn(),
  uploadRuntimeConfigIfChanged: vi.fn(),
  patchControledMihomoConfig: vi.fn(),
  setPublicDNS: vi.fn(),
  recoverDNS: vi.fn(),
  checkAdminRestartForTun: vi.fn(),
  getSessionAdminStatus: vi.fn(),
  setStopCoreBeforeAdminRestart: vi.fn()
}))

vi.mock('child_process', () => ({
  spawn: mocks.spawn,
  execFile: mocks.execFile
}))

vi.mock('electron', () => ({
  app: {
    exit: vi.fn(),
    isReady: () => true
  },
  ipcMain: new EventEmitter()
}))

vi.mock('i18next', () => ({
  default: {
    t: (key: string) => key
  }
}))

vi.mock('../utils/init', () => ({
  ensureRuntimeFiles: mocks.ensureRuntimeFiles,
  safeShowErrorBox: vi.fn()
}))

vi.mock('../utils/dirs', () => ({
  dataDir: () => mocks.testDir,
  coreLogPath: () => join(mocks.testDir, 'logs', 'core.log'),
  mihomoCoreDir: () => join(mocks.testDir, 'core'),
  mihomoCorePath: () => join(mocks.testDir, 'mihomo'),
  mihomoProfileWorkDir: (id: string) => join(mocks.testDir, 'profiles-work', id),
  mihomoTestDir: () => join(mocks.testDir, 'test'),
  mihomoWorkConfigPath: (id: string | undefined) =>
    join(mocks.testDir, id === 'work' ? 'work' : 'profiles-work', id || 'default', 'config.yaml'),
  mihomoWorkDir: () => join(mocks.testDir, 'work')
}))

vi.mock('../utils/logger', () => ({
  managerLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }
}))

vi.mock('../utils/logFile', () => ({
  createCoreLogWritableStream: () =>
    new Writable({
      write(_chunk, _encoding, callback) {
        callback()
      }
    })
}))

vi.mock('../config', () => ({
  getAppConfig: mocks.getAppConfig,
  getControledMihomoConfig: mocks.getControledMihomoConfig,
  getProfileItem: mocks.getProfileItem,
  patchControledMihomoConfig: mocks.patchControledMihomoConfig,
  manageSmartOverride: mocks.manageSmartOverride
}))

vi.mock('../resolve/gistApi', () => ({
  uploadRuntimeConfigIfChanged: mocks.uploadRuntimeConfigIfChanged
}))

vi.mock('../window', () => ({
  mainWindow: {
    webContents: {
      send: vi.fn()
    }
  }
}))

vi.mock('../utils/age', () => ({
  parseAgeSecretKeys: () => []
}))

vi.mock('./factory', () => ({
  generateProfile: mocks.generateProfile
}))

vi.mock('./mihomoApi', () => ({
  startMihomoTraffic: mocks.startMihomoTraffic,
  startMihomoConnections: mocks.startMihomoConnections,
  startMihomoLogs: mocks.startMihomoLogs,
  startMihomoMemory: mocks.startMihomoMemory,
  stopMihomoTraffic: mocks.stopMihomoTraffic,
  stopMihomoConnections: mocks.stopMihomoConnections,
  stopMihomoLogs: mocks.stopMihomoLogs,
  stopMihomoMemory: mocks.stopMihomoMemory,
  patchMihomoConfig: mocks.patchMihomoConfig,
  getAxios: mocks.getAxios
}))

vi.mock('./process', () => ({
  cleanupSocketFile: mocks.cleanupSocketFile,
  cleanupWindowsNamedPipes: vi.fn(),
  validateWindowsPipeAccess: vi.fn(),
  waitForCoreReady: mocks.waitForCoreReady,
  verifyProcessOwner: mocks.verifyProcessOwner
}))

vi.mock('./dns', () => ({
  setPublicDNS: mocks.setPublicDNS,
  recoverDNS: mocks.recoverDNS
}))

vi.mock('./permissions', () => ({
  checkAdminRestartForTun: mocks.checkAdminRestartForTun,
  getSessionAdminStatus: mocks.getSessionAdminStatus,
  setStopCoreBeforeAdminRestart: mocks.setStopCoreBeforeAdminRestart,
  initAdminStatus: vi.fn(),
  checkAdminPrivileges: vi.fn(),
  checkHighPrivilegeCore: vi.fn(),
  grantTunPermissions: vi.fn(),
  restartAsAdmin: vi.fn(),
  requestTunPermissions: vi.fn(),
  showTunPermissionDialog: vi.fn(),
  showErrorDialog: vi.fn(),
  checkTunPermissions: vi.fn(),
  manualGrantCorePermition: vi.fn()
}))

interface FakeCoreProcess extends EventEmitter {
  pid: number
  killed: boolean
  exitCode: number | null
  signalCode: NodeJS.Signals | null
  stdout: PassThrough
  stderr: PassThrough
  kill: ReturnType<typeof vi.fn>
  unref: ReturnType<typeof vi.fn>
}

function createFakeCoreProcess(pid: number): FakeCoreProcess {
  const proc = new EventEmitter() as FakeCoreProcess
  proc.pid = pid
  proc.killed = false
  proc.exitCode = null
  proc.signalCode = null
  proc.stdout = new PassThrough()
  proc.stderr = new PassThrough()
  proc.kill = vi.fn((signal?: NodeJS.Signals) => {
    proc.killed = true
    proc.signalCode = signal || null
    return true
  })
  proc.unref = vi.fn()
  return proc
}

function succeedExecFile(
  _file: string,
  _args: string[],
  _options: unknown,
  callback: (error: Error | null, stdout: string, stderr: string) => void
): void {
  callback(null, 'configuration test is successful', '')
}

function failExecFileWithMissingProxy(
  _file: string,
  _args: string[],
  _options: unknown,
  callback: (
    error: Error & { stdout?: string; stderr?: string },
    stdout: string,
    stderr: string
  ) => void
): void {
  const error = new Error('configuration test failed') as Error & {
    stdout?: string
    stderr?: string
  }
  error.stdout =
    'time="2026-08-27T10:00:00+08:00" level=error msg="proxy group[0]: 自动选择: missing-proxy not found"\n'
  error.stderr = ''
  callback(error, error.stdout, '')
}

async function startReadyCore(startCore: () => Promise<Promise<void>[]>, proc: FakeCoreProcess) {
  const startPromise = startCore()
  await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalled())
  proc.stdout.write('RESTful API unix listening at: /tmp/mihomo-party-test.sock\n')
  const completionTasks = await startPromise
  await new Promise((resolve) => setImmediate(resolve))
  proc.stdout.write('Start initial compatible provider default\n')
  await Promise.all(completionTasks)
}

describe('core manager restart safety', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.resetAllMocks()
    mocks.testDir = mkdtempSync(join(tmpdir(), 'mihomo-party-manager-test-'))
    mkdirSync(join(mocks.testDir, 'logs'), { recursive: true })
    mocks.ensureRuntimeFiles.mockResolvedValue(undefined)
    mocks.getAppConfig.mockResolvedValue({
      core: 'mihomo',
      autoSetDNS: false,
      diffWorkDir: false,
      mihomoCpuPriority: 'PRIORITY_NORMAL',
      coreStartupMode: 'log',
      testProfileOnStart: true
    })
    mocks.getControledMihomoConfig.mockResolvedValue({
      'log-level': 'info',
      tun: { enable: false }
    })
    mocks.getProfileItem.mockResolvedValue(undefined)
    mocks.manageSmartOverride.mockResolvedValue(undefined)
    mocks.generateProfile.mockResolvedValue('default')
    mocks.cleanupSocketFile.mockResolvedValue(undefined)
    mocks.waitForCoreReady.mockResolvedValue(undefined)
    mocks.verifyProcessOwner.mockResolvedValue(true)
    mocks.getAxios.mockResolvedValue({ get: vi.fn().mockResolvedValue({}) })
    mocks.startMihomoTraffic.mockResolvedValue(undefined)
    mocks.startMihomoConnections.mockResolvedValue(undefined)
    mocks.startMihomoLogs.mockResolvedValue(undefined)
    mocks.startMihomoMemory.mockResolvedValue(undefined)
    mocks.patchMihomoConfig.mockResolvedValue(undefined)
    mocks.uploadRuntimeConfigIfChanged.mockResolvedValue(undefined)
    mocks.execFile.mockImplementation(succeedExecFile)
  })

  afterEach(() => {
    rmSync(mocks.testDir, { recursive: true, force: true })
  })

  it('keeps the running core alive when the replacement profile fails validation', async () => {
    const oldCore = createFakeCoreProcess(991001)
    mocks.spawn.mockReturnValueOnce(oldCore).mockImplementation(() => createFakeCoreProcess(991999))

    const { restartCore, startCore } = await import('./manager')
    await startReadyCore(startCore, oldCore)

    mocks.execFile.mockImplementationOnce(failExecFileWithMissingProxy)

    await expect(restartCore()).rejects.toThrow('missing-proxy')
    expect(oldCore.kill).not.toHaveBeenCalled()
  })

  it('records attached core pid for next-start cleanup instead of using a crash watchdog', async () => {
    const core = createFakeCoreProcess(991101)
    mocks.spawn.mockReturnValue(core)

    const { startCore } = await import('./manager')
    await startReadyCore(startCore, core)

    expect(mocks.spawn).toHaveBeenCalledTimes(1)
    expect(readFileSync(join(mocks.testDir, 'core.pid'), 'utf8')).toBe('991101')
  })
})
