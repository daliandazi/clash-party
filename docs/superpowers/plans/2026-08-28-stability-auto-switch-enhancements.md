# Stability Auto Switch Enhancements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve Clash Party long-running reliability by adding resume recovery, runtime diagnostics, safer automatic delay tests, and configurable node exclusions.

**Architecture:** Reuse the existing `autoProxySwitch` service as the single node-selection engine. Add small, focused extensions to its config/state; add a separate `runtimeHealth` coordinator for resume recovery and diagnostics so lifecycle code stays mechanical. UI changes stay inside the existing auto-switch modal/status components.

**Tech Stack:** Electron main process, React renderer, TypeScript, Vitest, existing IPC/logger/config abstractions.

---

## File Structure

- Modify `src/shared/types.d.ts`
  - Add `delayConcurrency`, `retryTimeoutOnce`, `excludePatterns`, `excludedProxies`, recovery fields, and runtime diagnostics config.
- Modify `src/main/utils/template.ts`
  - Add defaults for new config fields.
- Modify `src/main/core/autoProxySwitch.ts`
  - Add exclusion filtering, candidate retry-on-timeout, and automatic-test concurrency config.
- Modify `src/main/core/autoProxySwitch.test.ts`
  - Add RED/GREEN tests for new auto-switch behavior.
- Create `src/main/core/runtimeHealth.ts`
  - Own resume recovery cooldown and periodic diagnostics.
- Create `src/main/core/runtimeHealth.test.ts`
  - Test resume recovery decisions and diagnostics scheduling.
- Modify `src/main/lifecycle.ts`
  - Wire `powerMonitor.resume` to runtime health coordinator.
- Modify `src/main/index.ts`
  - Start/stop runtime diagnostics with other background services.
- Modify `src/renderer/src/components/proxies/auto-switch-modal.tsx`
  - Add fool-proof controls for exclusion patterns, retry, and background concurrency.
- Modify `src/renderer/src/components/proxies/auto-switch-status.tsx`
  - Show excluded count and recovery summary.
- Modify locale JSON files under `src/renderer/src/locales/`
  - Add labels for new UI fields.

## Task 1: Auto-switch config/state schema

**Files:**

- Modify: `src/shared/types.d.ts`
- Modify: `src/main/utils/template.ts`
- Test: `src/main/core/autoProxySwitch.test.ts`

- [ ] **Step 1: Write failing normalization test**

Add a test in `describe('autoProxySwitch pure functions')`:

```ts
it('normalizes retry, background concurrency, and exclusion defaults', () => {
  const value = normalizeAutoSwitchConfig({
    delayConcurrency: 99,
    retryTimeoutOnce: false,
    excludePatterns: [' HK ', '', '/倍率/i']
  })

  expect(value.delayConcurrency).toBe(20)
  expect(value.retryTimeoutOnce).toBe(false)
  expect(value.excludePatterns).toEqual(['HK', '/倍率/i'])
})
```

- [ ] **Step 2: Verify RED**

Run:

```bash
pnpm vitest run src/main/core/autoProxySwitch.test.ts
```

Expected: TypeScript/test failure because `delayConcurrency`, `retryTimeoutOnce`, and `excludePatterns` are not implemented.

- [ ] **Step 3: Implement schema defaults**

Update `IProxyAutoSwitchConfig` and `IProxyAutoSwitchState` in `src/shared/types.d.ts`:

```ts
interface IProxyAutoSwitchExcludedProxy {
  name: string
  pattern: string
}

interface IProxyAutoSwitchConfig {
  enabled: boolean
  targetGroup: string
  activeIntervalSec: number
  standbyIntervalSec: number
  switchCooldownSec: number
  maxDelayMs: number
  failureThreshold: number
  closeConnectionsOnSwitch: boolean
  delayConcurrency: number
  retryTimeoutOnce: boolean
  excludePatterns: string[]
  regions: IProxyAutoSwitchRegion[]
}
```

Add to `IProxyAutoSwitchState`:

```ts
excludedProxies?: IProxyAutoSwitchExcludedProxy[]
lastRecoveryAt?: string
lastRecoveryAction?: string
```

Update `DEFAULT_AUTO_SWITCH_CONFIG` and `defaultConfig.proxyAutoSwitch`:

```ts
delayConcurrency: 4,
retryTimeoutOnce: true,
excludePatterns: [],
```

Update `normalizeAutoSwitchConfig()`:

```ts
delayConcurrency: clampNumber(value?.delayConcurrency, defaults.delayConcurrency ?? 4, 1),
retryTimeoutOnce: value?.retryTimeoutOnce !== false,
excludePatterns: Array.isArray(value?.excludePatterns)
  ? value.excludePatterns.map((pattern) => String(pattern).trim()).filter(Boolean)
  : defaults.excludePatterns ?? [],
```

Then cap `delayConcurrency` to 20 after normalization.

- [ ] **Step 4: Verify GREEN**

Run:

```bash
pnpm vitest run src/main/core/autoProxySwitch.test.ts
```

Expected: auto-switch tests pass.

## Task 2: Node exclusion and preview state

**Files:**

- Modify: `src/main/core/autoProxySwitch.ts`
- Modify: `src/main/core/autoProxySwitch.test.ts`

- [ ] **Step 1: Write failing exclusion tests**

Add pure-function tests:

```ts
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
```

- [ ] **Step 2: Verify RED**

Run:

```bash
pnpm vitest run src/main/core/autoProxySwitch.test.ts
```

Expected: failure because `buildRegionBuckets()` does not accept exclusions or return `excludedProxies`.

- [ ] **Step 3: Implement exclusion filtering**

Add helper:

```ts
function matchPattern(value: string, patterns: string[]): string | undefined {
  for (const pattern of patterns) {
    const regex = compilePattern(pattern)
    if (regex?.test(value)) return pattern
  }
  return undefined
}
```

Update `buildRegionBuckets()` signature:

```ts
export function buildRegionBuckets(
  proxies: { name: string; provider?: string }[],
  regions: IProxyAutoSwitchRegion[],
  excludePatterns: string[] = []
): {
  candidates: AutoSwitchCandidateProxy[]
  buckets: IProxyAutoSwitchBucket[]
  unknownProxies: string[]
  excludedProxies: IProxyAutoSwitchExcludedProxy[]
}
```

Before region classification:

```ts
const excludedBy = matchPattern(proxy.name, excludePatterns)
if (excludedBy) {
  excludedProxies.push({ name: proxy.name, pattern: excludedBy })
  return
}
```

Update `loadTargetGroupContext()` to pass `configValue.excludePatterns ?? []` and publish `excludedProxies`.

- [ ] **Step 4: Verify GREEN**

Run:

```bash
pnpm vitest run src/main/core/autoProxySwitch.test.ts
```

Expected: auto-switch tests pass.

## Task 3: Safer delay test concurrency and timeout retry

**Files:**

- Modify: `src/main/core/autoProxySwitch.ts`
- Modify: `src/main/core/autoProxySwitch.test.ts`

- [ ] **Step 1: Write failing retry test**

Add service test:

```ts
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
```

- [ ] **Step 2: Write failing concurrency test**

Add:

```ts
it('uses auto-switch delayConcurrency instead of global manual delay concurrency', async () => {
  deps.getAppConfig.mockResolvedValue({
    proxyAutoSwitch: { ...baseConfig, delayConcurrency: 1 },
    delayTestConcurrency: 50
  })
  deps.mihomoGroups.mockResolvedValue([
    group('US-01', [proxy('US-01'), proxy('US-02'), proxy('JP-01')])
  ])
  deps.mihomoProxyDelay.mockResolvedValue({ delay: 100 })
  const service = createAutoProxySwitchService(deps)

  await service.runCheck('standby')

  expect(deps.mihomoProxyDelay.mock.invocationCallOrder[1]).toBeLessThan(
    deps.mihomoProxyDelay.mock.invocationCallOrder[2]
  )
})
```

If the call-order assertion is too weak, replace it with a controlled promise test that proves max in-flight count is 1.

- [ ] **Step 3: Verify RED**

Run:

```bash
pnpm vitest run src/main/core/autoProxySwitch.test.ts
```

Expected: retry and concurrency tests fail.

- [ ] **Step 4: Implement retry and config concurrency**

Update `checkOneProxy()`:

```ts
async function checkOneProxy(
  proxy: AutoSwitchCandidateProxy,
  maxDelayMs: number,
  testUrl?: string,
  retryTimeoutOnce = false
): Promise<IProxyAutoSwitchDelayEntry> {
  const first = await checkOneProxyOnce(proxy, maxDelayMs, testUrl)
  if ((first.delay <= 0 || first.error) && retryTimeoutOnce) {
    return await checkOneProxyOnce(proxy, maxDelayMs, testUrl)
  }
  return first
}
```

Extract existing body into `checkOneProxyOnce()`.

Update `checkCandidatesWithLimit()`:

```ts
const concurrency = Math.min(Math.max(configValue.delayConcurrency ?? 4, 1), 20)
await runWithConcurrency(candidates, concurrency, async (candidate) => {
  await checkOneProxy(candidate, configValue.maxDelayMs, testUrl, configValue.retryTimeoutOnce)
})
```

Only candidate/standby checks should pass the retry flag. Active current-proxy checks should pass `false` so failover is not delayed by an extra timeout.

Add tests that prove:

- high-latency-but-responsive candidates are not retried;
- `retryTimeoutOnce=false` disables candidate retry;
- old active timers do not reschedule after `restart()`.

- [ ] **Step 5: Verify GREEN**

Run:

```bash
pnpm vitest run src/main/core/autoProxySwitch.test.ts
```

Expected: auto-switch tests pass.

## Task 4: Runtime health coordinator

**Files:**

- Create: `src/main/core/runtimeHealth.ts`
- Create: `src/main/core/runtimeHealth.test.ts`
- Modify: `src/main/lifecycle.ts`
- Modify: `src/main/index.ts`

- [ ] **Step 1: Write failing runtime health tests**

Create `src/main/core/runtimeHealth.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createRuntimeHealthService } from './runtimeHealth'

describe('runtime health service', () => {
  const deps = {
    runAutoProxySwitchCheck: vi.fn(),
    restartCore: vi.fn(),
    hasCoreProcess: vi.fn(),
    getAutoProxySwitchState: vi.fn(),
    getAppConfig: vi.fn(),
    logInfo: vi.fn(),
    logWarn: vi.fn(),
    now: vi.fn(),
    setTimer: vi.fn(),
    clearTimer: vi.fn()
  }

  beforeEach(() => {
    vi.clearAllMocks()
    deps.now.mockReturnValue(new Date('2026-08-28T00:00:00.000Z'))
    deps.hasCoreProcess.mockReturnValue(true)
    deps.getAutoProxySwitchState.mockReturnValue({
      running: true,
      paused: false,
      checkingActive: false,
      checkingStandby: false,
      consecutiveFailures: {},
      lastDelays: {},
      buckets: [],
      unknownProxies: []
    })
    deps.getAppConfig.mockResolvedValue({
      runtimeDiagnostics: { enabled: true, intervalSec: 300, logMemory: true, logCoreState: true }
    })
    deps.setTimer.mockImplementation((handler: () => void) => handler)
  })

  it('runs auto-switch recovery after resume delay', async () => {
    deps.runAutoProxySwitchCheck.mockResolvedValue({ lastError: undefined })
    const service = createRuntimeHealthService(deps)

    await service.handleResume()

    expect(deps.runAutoProxySwitchCheck).toHaveBeenCalledWith('active')
    expect(deps.restartCore).not.toHaveBeenCalled()
  })

  it('restarts core when resume recovery cannot find a usable proxy', async () => {
    deps.runAutoProxySwitchCheck.mockResolvedValue({ lastError: '没有可用候选节点' })
    const service = createRuntimeHealthService(deps)

    await service.handleResume()

    expect(deps.restartCore).toHaveBeenCalledWith(true)
  })

  it('skips repeated resume recovery during cooldown', async () => {
    deps.runAutoProxySwitchCheck.mockResolvedValue({ lastError: undefined })
    const service = createRuntimeHealthService(deps)

    await service.handleResume()
    await service.handleResume()

    expect(deps.runAutoProxySwitchCheck).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: Verify RED**

Run:

```bash
pnpm vitest run src/main/core/runtimeHealth.test.ts
```

Expected: import failure because `runtimeHealth.ts` does not exist.

- [ ] **Step 3: Implement runtime health service**

Create `src/main/core/runtimeHealth.ts` exporting:

```ts
export function createRuntimeHealthService(deps: RuntimeHealthDeps): RuntimeHealthService
export async function handleRuntimeResume(): Promise<void>
export async function startRuntimeDiagnostics(): Promise<void>
export function stopRuntimeDiagnostics(): void
```

Core behavior:

- `handleResume()` respects a 60 second cooldown.
- It waits `resumeDelayMs`, default 5000; tests inject 0.
- It calls `runAutoProxySwitchCheck('active')`.
- If returned state has `lastError` in `['没有可用候选节点', '目标代理组不存在', '未选择目标代理组']` or `hasCoreProcess()` is false, call `restartCore(true)`.
- Diagnostics logs compact JSON-safe summaries only.

- [ ] **Step 4: Wire lifecycle and startup**

In `src/main/lifecycle.ts`, import `handleRuntimeResume` and add:

```ts
powerMonitor.on('resume', () => {
  void handleRuntimeResume()
})
```

In `src/main/index.ts`, import `startRuntimeDiagnostics`, `stopRuntimeDiagnostics`. Start diagnostics with background services after core ready, and stop it during app shutdown path if needed.

- [ ] **Step 5: Verify GREEN**

Run:

```bash
pnpm vitest run src/main/core/runtimeHealth.test.ts
```

Expected: runtime health tests pass.

## Task 5: Auto-switch UI enhancements

**Files:**

- Modify: `src/renderer/src/components/proxies/auto-switch-modal.tsx`
- Modify: `src/renderer/src/components/proxies/auto-switch-status.tsx`
- Modify: `src/renderer/src/locales/zh-CN.json`
- Modify: `src/renderer/src/locales/en-US.json`
- Modify: `src/renderer/src/locales/zh-TW.json`
- Modify: `src/renderer/src/locales/fa-IR.json`
- Modify: `src/renderer/src/locales/ru-RU.json`

- [ ] **Step 1: Implement UI controls**

Add to modal defaults:

```ts
delayConcurrency: 4,
retryTimeoutOnce: true,
excludePatterns: []
```

Add textarea parsing using existing `parsePatterns()`.

Add validation for `excludePatterns` using existing `isValidPattern()`.

Preview should separate:

```ts
const excluded: IProxyAutoSwitchExcludedProxy[] = []
const excludedBy = matchPattern(proxy.name, draft.excludePatterns ?? [])
```

Then do not include excluded nodes in region buckets.

- [ ] **Step 2: Add visible status**

In `auto-switch-status.tsx`, show:

```tsx
{
  state?.excludedProxies?.length ? (
    <span className="text-foreground-500">
      {t('proxies.autoSwitch.excluded')}: {state.excludedProxies.length}
    </span>
  ) : null
}
{
  state?.lastRecoveryAction ? (
    <span className="text-foreground-500">
      {t('proxies.autoSwitch.lastRecovery')}: {state.lastRecoveryAction}
    </span>
  ) : null
}
```

- [ ] **Step 3: Add locale keys**

Add keys:

```json
"proxies.autoSwitch.delayConcurrency": "后台检测并发",
"proxies.autoSwitch.retryTimeoutOnce": "失败后重试一次",
"proxies.autoSwitch.excludePatterns": "排除节点",
"proxies.autoSwitch.excludePatternsPlaceholder": "例：香港, HK, 高倍, /[35]x/i",
"proxies.autoSwitch.excluded": "已排除",
"proxies.autoSwitch.lastRecovery": "最近恢复"
```

Translate English/TW/Farsi/Russian conservatively.

- [ ] **Step 4: Verify typecheck**

Run:

```bash
pnpm run typecheck
```

Expected: no TypeScript errors.

## Task 6: Full verification and local commit

**Files:**

- All changed files.

- [ ] **Step 1: Run focused tests**

```bash
pnpm vitest run src/main/core/autoProxySwitch.test.ts src/main/core/runtimeHealth.test.ts
```

Expected: all focused tests pass.

- [ ] **Step 2: Run full tests**

```bash
pnpm test
```

Expected: all tests pass.

- [ ] **Step 3: Run project review gate**

```bash
pnpm run review
```

Expected: exit 0; existing warnings may remain, but no errors.

- [ ] **Step 4: Build Linux app**

```bash
pnpm run build:linux
```

Expected: exit 0 and artifacts under `dist/`.

- [ ] **Step 5: Inspect diff**

```bash
git diff --stat
git diff --check
```

Expected: no whitespace errors; changes limited to planned files.

- [ ] **Step 6: Commit locally**

```bash
git add docs/superpowers/specs/2026-08-28-stability-auto-switch-enhancements-design.md docs/superpowers/plans/2026-08-28-stability-auto-switch-enhancements.md src/shared/types.d.ts src/main/utils/template.ts src/main/core/autoProxySwitch.ts src/main/core/autoProxySwitch.test.ts src/main/core/runtimeHealth.ts src/main/core/runtimeHealth.test.ts src/main/lifecycle.ts src/main/index.ts src/renderer/src/components/proxies/auto-switch-modal.tsx src/renderer/src/components/proxies/auto-switch-status.tsx src/renderer/src/locales/zh-CN.json src/renderer/src/locales/en-US.json src/renderer/src/locales/zh-TW.json src/renderer/src/locales/fa-IR.json src/renderer/src/locales/ru-RU.json
git commit -m "feat: improve auto switch resilience and diagnostics"
```

Commit body must mention:

- GitHub issues addressed: #1933, #1224, #159, #1976, #1507, #527, partial #1549.
- Resume recovery strategy.
- Runtime diagnostics purpose.
- Safer delay test retry/concurrency.
- Node exclusion UI.

Do not use `--no-verify`.
