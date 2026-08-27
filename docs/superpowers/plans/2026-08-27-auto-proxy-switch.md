# Auto Proxy Switch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. User instruction for this branch: local development only, do not commit unless explicitly re-authorized.

**Goal:** 为 Clash Party 增加可配置的后台自动延迟检测与地区兜底切换能力。

**Architecture:** 在主进程新增 `autoProxySwitch` 服务，复用现有 Mihomo API 做测速与切换；配置存入 `IAppConfig.proxyAutoSwitch`；渲染进程在代理组页提供傻瓜配置弹窗、地区识别预览和状态条。服务不修改订阅源，不依赖 `mihomo-smart`。

**Tech Stack:** Electron 主进程、React 渲染进程、TypeScript、Vitest、现有 IPC 封装、现有 `mihomoApi.ts`。

---

## 文件结构

- Create: `src/main/core/autoProxySwitch.ts`
  - 自动切换核心逻辑、状态、调度器、测试辅助纯函数。
- Create: `src/main/core/autoProxySwitch.test.ts`
  - 自动切换纯函数和调度决策测试。
- Modify: `src/shared/types.d.ts`
  - 新增自动切换配置、状态、分桶类型。
- Modify: `src/main/utils/template.ts`
  - 新增默认 `proxyAutoSwitch` 配置。
- Modify: `src/main/utils/ipc.ts`
  - 注册主进程 IPC：状态查询、立即检测、重启服务。
- Modify: `src/renderer/src/utils/ipc.ts`
  - 暴露渲染进程 IPC 类型和方法。
- Modify: `src/preload/index.ts`
  - 增加 invoke/listen channel 白名单。
- Modify if present/needed: `src/preload/index.d.ts`
  - 同步 preload 类型。
- Create: `src/renderer/src/components/proxies/auto-switch-modal.tsx`
  - 傻瓜配置弹窗。
- Create: `src/renderer/src/components/proxies/auto-switch-status.tsx`
  - 代理组页自动切换状态条。
- Modify: `src/renderer/src/pages/proxies.tsx`
  - 增加入口、状态条、弹窗挂载。
- Modify: `src/renderer/src/locales/zh-CN.json`
  - 中文文案。
- Modify: `src/renderer/src/locales/en-US.json`
  - 英文文案。
- Modify: `src/main/index.ts`
  - 在 Mihomo core 启动成功后的后台任务中启动自动切换服务。

## Task 1: 添加共享类型和默认配置

**Files:**

- Modify: `src/shared/types.d.ts`
- Modify: `src/main/utils/template.ts`

- [ ] **Step 1: 在 `src/shared/types.d.ts` 增加类型**

在 `INetworkLatencyTarget` 后加入：

```ts
interface IProxyAutoSwitchRegion {
  id: string
  name: string
  patterns: string[]
  enabled: boolean
}

interface IProxyAutoSwitchConfig {
  enabled: boolean
  targetGroup?: string
  activeIntervalSec: number
  standbyIntervalSec: number
  switchCooldownSec: number
  maxDelayMs: number
  failureThreshold: number
  closeConnectionsOnSwitch: boolean
  regions: IProxyAutoSwitchRegion[]
}

interface IProxyAutoSwitchDelayEntry {
  delay: number
  time: string
  alive: boolean
  error?: string
}

interface IProxyAutoSwitchBucket {
  id: string
  name: string
  proxies: string[]
}

interface IProxyAutoSwitchState {
  running: boolean
  paused: boolean
  checkingActive: boolean
  checkingStandby: boolean
  currentGroup?: string
  currentProxy?: string
  currentRegion?: string
  lastActiveCheckAt?: string
  lastStandbyCheckAt?: string
  nextActiveCheckAt?: string
  nextStandbyCheckAt?: string
  lastSwitchAt?: string
  lastSwitchReason?: string
  consecutiveFailures: Record<string, number>
  lastDelays: Record<string, IProxyAutoSwitchDelayEntry>
  buckets: IProxyAutoSwitchBucket[]
  unknownProxies: string[]
  lastError?: string
}
```

在 `IAppConfig` 中加入：

```ts
proxyAutoSwitch?: IProxyAutoSwitchConfig
```

- [ ] **Step 2: 在 `src/main/utils/template.ts` 增加默认配置**

在 `defaultConfig` 中加入：

```ts
proxyAutoSwitch: {
  enabled: false,
  targetGroup: '',
  activeIntervalSec: 15,
  standbyIntervalSec: 300,
  switchCooldownSec: 180,
  maxDelayMs: 800,
  failureThreshold: 2,
  closeConnectionsOnSwitch: true,
  regions: [
    { id: 'us', name: '美国', patterns: ['US', '美国', 'United States'], enabled: true },
    { id: 'jp', name: '日本', patterns: ['JP', '日本', 'Japan'], enabled: true },
    { id: 'sg', name: '新加坡', patterns: ['SG', '新加坡', 'Singapore'], enabled: true },
    { id: 'hk', name: '香港', patterns: ['HK', '香港', 'Hong Kong'], enabled: true }
  ]
}
```

- [ ] **Step 3: 检查类型**

Run:

```bash
pnpm run typecheck
```

Expected: 命令退出码为 0。

## Task 2: 实现核心纯函数和测试

**Files:**

- Create: `src/main/core/autoProxySwitch.ts`
- Create: `src/main/core/autoProxySwitch.test.ts`

- [ ] **Step 1: 写纯函数测试**

创建 `src/main/core/autoProxySwitch.test.ts`，覆盖：

```ts
import { describe, expect, it } from 'vitest'
import {
  buildRegionBuckets,
  chooseBestCandidate,
  classifyProxyRegion,
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
    expect(value.failureThreshold).toBe(1)
    expect(value.regions.length).toBeGreaterThan(0)
  })

  it('classifies proxy by keyword using region priority', () => {
    expect(classifyProxyRegion('US-01 日本备份', config.regions)?.id).toBe('us')
  })

  it('classifies proxy by slash regex', () => {
    expect(classifyProxyRegion('JP Tokyo 01', config.regions)?.id).toBe('jp')
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
})
```

- [ ] **Step 2: 运行测试，确认当前失败**

Run:

```bash
pnpm vitest run src/main/core/autoProxySwitch.test.ts
```

Expected: `Failed to resolve import "./autoProxySwitch"`。

- [ ] **Step 3: 实现纯函数和常量**

在 `src/main/core/autoProxySwitch.ts` 中先实现：

```ts
interface AutoSwitchCandidateProxy {
  name: string
  provider?: string
  regionId?: string
}

const DEFAULT_AUTO_SWITCH_CONFIG: IProxyAutoSwitchConfig = {
  enabled: false,
  targetGroup: '',
  activeIntervalSec: 15,
  standbyIntervalSec: 300,
  switchCooldownSec: 180,
  maxDelayMs: 800,
  failureThreshold: 2,
  closeConnectionsOnSwitch: true,
  regions: [
    { id: 'us', name: '美国', patterns: ['US', '美国', 'United States'], enabled: true },
    { id: 'jp', name: '日本', patterns: ['JP', '日本', 'Japan'], enabled: true },
    { id: 'sg', name: '新加坡', patterns: ['SG', '新加坡', 'Singapore'], enabled: true },
    { id: 'hk', name: '香港', patterns: ['HK', '香港', 'Hong Kong'], enabled: true }
  ]
}
```

核心函数必须包括：

```ts
export function normalizeAutoSwitchConfig(
  value?: Partial<IProxyAutoSwitchConfig>
): IProxyAutoSwitchConfig

export function classifyProxyRegion(
  proxyName: string,
  regions: IProxyAutoSwitchRegion[]
): IProxyAutoSwitchRegion | undefined

export function isDelayUsable(delay: number | undefined, maxDelayMs: number): boolean

export function buildRegionBuckets(
  proxies: { name: string; provider?: string }[],
  regions: IProxyAutoSwitchRegion[]
): {
  candidates: AutoSwitchCandidateProxy[]
  buckets: IProxyAutoSwitchBucket[]
  unknownProxies: string[]
}

export function chooseBestCandidate(
  candidates: AutoSwitchCandidateProxy[],
  config: IProxyAutoSwitchConfig,
  delays: Record<string, IProxyAutoSwitchDelayEntry>,
  currentProxy?: string
): AutoSwitchCandidateProxy | undefined
```

实现要求：

- 普通 pattern 做大小写不敏感包含匹配。
- `/.../flags` pattern 做正则匹配，非法正则不抛出到外层。
- `normalizeAutoSwitchConfig()` 最低 active 间隔 5 秒，最低 standby 间隔 30 秒，最低冷却 30 秒，最低失败阈值 1。
- `chooseBestCandidate()` 按 `regions` 顺序扫描，过滤当前节点，选择可用且延迟最低候选。

- [ ] **Step 4: 运行测试**

Run:

```bash
pnpm vitest run src/main/core/autoProxySwitch.test.ts
```

Expected: 命令退出码为 0。

## Task 3: 实现主进程 scheduler

**Files:**

- Modify: `src/main/core/autoProxySwitch.ts`

- [ ] **Step 1: 增加 Mihomo API 和配置依赖**

需要使用：

```ts
import { mainWindow } from '../window'
import { getAppConfig } from '../config'
import {
  mihomoChangeProxy,
  mihomoCloseAllConnections,
  mihomoGroups,
  mihomoProxyDelay
} from './mihomoApi'
```

- [ ] **Step 2: 增加服务状态**

状态要求：

```ts
let activeTimer: ReturnType<typeof setTimeout> | undefined
let standbyTimer: ReturnType<typeof setTimeout> | undefined
let checkingActive = false
let checkingStandby = false
let state: IProxyAutoSwitchState = {
  running: false,
  paused: false,
  checkingActive: false,
  checkingStandby: false,
  consecutiveFailures: {},
  lastDelays: {},
  buckets: [],
  unknownProxies: []
}
```

不能使用单个全局 `checking`，否则 standby 批量检测会挡住 active 高频检测。

- [ ] **Step 3: 增加 public API**

实现：

```ts
export function getAutoProxySwitchState(): IProxyAutoSwitchState
export async function startAutoProxySwitch(): Promise<IProxyAutoSwitchState>
export function stopAutoProxySwitch(): IProxyAutoSwitchState
export async function restartAutoProxySwitch(): Promise<IProxyAutoSwitchState>
export async function runAutoProxySwitchCheck(
  reason: 'manual' | 'active' | 'standby' = 'manual'
): Promise<IProxyAutoSwitchState>
```

- [ ] **Step 4: 实现 active 检测**

active 逻辑：

```ts
async function runActiveCheck(config: IProxyAutoSwitchConfig): Promise<void> {
  if (checkingActive) return
  checkingActive = true
  updateState({ checkingActive: true })
  try {
    const context = await loadTargetGroupContext(config)
    if (!context) return
    await checkOneProxy(context.current, context.group.testUrl)
    if (currentProxyIsUnhealthy(config, context.current.name)) {
      await switchToBestCandidate(config, context)
    }
  } finally {
    checkingActive = false
    updateState({ checkingActive: false })
  }
}
```

要求：

- 只测当前节点。
- 当前节点失败计数达到阈值后才切换。
- standby 执行中也允许 active 执行。

- [ ] **Step 5: 实现 standby 检测**

standby 逻辑：

```ts
async function runStandbyCheck(config: IProxyAutoSwitchConfig): Promise<void> {
  if (checkingStandby || checkingActive) return
  checkingStandby = true
  updateState({ checkingStandby: true })
  try {
    const context = await loadTargetGroupContext(config)
    if (!context) return
    await checkCandidatesWithLimit(context.candidates, context.group.testUrl)
  } finally {
    checkingStandby = false
    updateState({ checkingStandby: false })
  }
}
```

要求：

- 低频全量刷新候选缓存。
- 使用 `delayTestConcurrency`，但后台最大并发不超过 20。
- standby 不主动切换。

- [ ] **Step 6: 实现切换**

切换逻辑：

```ts
async function switchToBestCandidate(
  config: IProxyAutoSwitchConfig,
  context: TargetGroupContext
): Promise<void>
```

要求：

- 冷却期内不切换。
- 优先扫描当前节点所属地区；当前地区无可用，再按配置顺序兜底。
- 当前地区候选缓存缺失或过旧时，只即时补测该地区。
- 调用 `mihomoChangeProxy(config.targetGroup, selected.name)`。
- `config.closeConnectionsOnSwitch` 为 true 时调用 `mihomoCloseAllConnections()`。
- 更新 `lastSwitchAt`、`lastSwitchReason`，并清理新节点失败计数。

- [ ] **Step 7: 增加 scheduler timer**

要求：

- `startAutoProxySwitch()` 读取配置；未启用时停止 timer 并返回非 running 状态。
- active timer 用 `setTimeout` 循环，不用 `setInterval`，避免任务重叠。
- standby timer 同样用 `setTimeout` 循环。
- `stopAutoProxySwitch()` 清理两个 timer。
- 每次状态变化通过 `mainWindow?.webContents.send('autoProxySwitchUpdated', state)` 通知 UI。

- [ ] **Step 8: 增加 scheduler 测试**

在 `autoProxySwitch.test.ts` 中 mock Mihomo API，覆盖：

- 当前节点连续失败达到阈值后切换。
- 同地区可用时优先同地区。
- 同地区不可用时切下一地区。
- provider 节点调用 `mihomoProxyDelay(name, url, provider)`。
- standby 执行中 active 不被全局锁阻塞。
- 冷却期内不切换。

Run:

```bash
pnpm vitest run src/main/core/autoProxySwitch.test.ts
```

Expected: 命令退出码为 0。

## Task 4: 接入 IPC 和启动生命周期

**Files:**

- Modify: `src/main/utils/ipc.ts`
- Modify: `src/renderer/src/utils/ipc.ts`
- Modify: `src/preload/index.ts`
- Modify if needed: `src/preload/index.d.ts`
- Modify: `src/main/index.ts`

- [ ] **Step 1: 主进程注册 IPC handler**

在 `src/main/utils/ipc.ts` import：

```ts
import {
  getAutoProxySwitchState,
  restartAutoProxySwitch,
  runAutoProxySwitchCheck
} from '../core/autoProxySwitch'
```

在 `asyncHandlers` 中加入：

```ts
getAutoProxySwitchState,
restartAutoProxySwitch,
runAutoProxySwitchCheck,
```

- [ ] **Step 2: renderer IPC wrapper**

在 `src/renderer/src/utils/ipc.ts` 的 API 类型和导出中加入：

```ts
getAutoProxySwitchState: () => Promise<IProxyAutoSwitchState>
restartAutoProxySwitch: () => Promise<IProxyAutoSwitchState>
runAutoProxySwitchCheck: (reason?: 'manual' | 'active' | 'standby') =>
  Promise<IProxyAutoSwitchState>
```

- [ ] **Step 3: preload 白名单**

在 `src/preload/index.ts` 的 `validInvokeChannels` 中加入：

```ts
'getAutoProxySwitchState',
'restartAutoProxySwitch',
'runAutoProxySwitchCheck',
```

在 `validListenChannels` 中加入：

```ts
'autoProxySwitchUpdated',
```

- [ ] **Step 4: core 启动后启动自动切换**

在 `src/main/index.ts` import：

```ts
import { startAutoProxySwitch } from './core/autoProxySwitch'
```

把启动加入 Mihomo core 启动成功后的后台任务列表，位置应与 `initProfileUpdater()`、`initWebdavBackupScheduler()` 同级：

```ts
startAutoProxySwitch().catch((e) => mainLogger.warn('Failed to init auto proxy switch', e))
```

不要在 `registerIpcMainHandlers()` 之后立即启动。

- [ ] **Step 5: 类型检查**

Run:

```bash
pnpm run typecheck
```

Expected: 命令退出码为 0。

## Task 5: 实现 UI 状态条和傻瓜配置弹窗

**Files:**

- Create: `src/renderer/src/components/proxies/auto-switch-status.tsx`
- Create: `src/renderer/src/components/proxies/auto-switch-modal.tsx`
- Modify: `src/renderer/src/pages/proxies.tsx`

- [ ] **Step 1: 状态条组件**

`auto-switch-status.tsx` 接收：

```ts
interface AutoSwitchStatusProps {
  state?: IProxyAutoSwitchState
  onOpenSettings: () => void
  onRunCheck: () => void
}
```

展示：

- 未启用：`自动切换：未启用`
- 运行中：组、当前节点、地区、最近 active 延迟、下次检测
- 暂停：paused reason / lastError
- 操作：配置、立即检测

- [ ] **Step 2: 配置弹窗组件**

`auto-switch-modal.tsx` 接收：

```ts
interface AutoSwitchModalProps {
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  groups: IMihomoMixedGroup[]
}
```

字段：

- `enabled`
- `targetGroup`
- `activeIntervalSec`
- `standbyIntervalSec`
- `maxDelayMs`
- `failureThreshold`
- `switchCooldownSec`
- `closeConnectionsOnSwitch`
- `regions[]`

保存逻辑：

```ts
await patchAppConfig({ proxyAutoSwitch: nextConfig })
await restartAutoProxySwitch()
```

- [ ] **Step 3: 地区识别预览**

弹窗内根据当前 `groups` 和临时配置实时计算：

```ts
const preview = buildRegionBuckets(
  selectedGroup.all.map((proxy) => ({
    name: proxy.name,
    provider: proxy['provider-name']
  })),
  draft.regions
)
```

必须展示每个地区识别到的节点数量和名称，以及 `unknownProxies`。这是傻瓜配置的核心。

- [ ] **Step 4: 地区编辑**

首版实现简单按钮即可，不要求拖拽：

- 新增地区。
- 删除地区。
- 上移。
- 下移。
- 启用/禁用。
- 修改名称。
- 修改关键词，使用逗号或换行分隔成 `patterns`。

- [ ] **Step 5: 接入代理页**

在 `src/renderer/src/pages/proxies.tsx`：

- import 新组件。
- 用 SWR 或 `useEffect` 调 `getAutoProxySwitchState()`。
- 监听 `autoProxySwitchUpdated` 更新状态。
- 在代理页顶部或工具区显示 `AutoSwitchStatus`。
- 挂载 `AutoSwitchModal`。

- [ ] **Step 6: UI 类型检查**

Run:

```bash
pnpm run typecheck
```

Expected: 命令退出码为 0。

## Task 6: 文案和最终验证

**Files:**

- Modify: `src/renderer/src/locales/zh-CN.json`
- Modify: `src/renderer/src/locales/en-US.json`

- [ ] **Step 1: 增加文案 key**

至少包含：

```json
{
  "proxies.autoSwitch.title": "自动切换",
  "proxies.autoSwitch.disabled": "自动切换：未启用",
  "proxies.autoSwitch.running": "自动切换：运行中",
  "proxies.autoSwitch.paused": "自动切换：已暂停",
  "proxies.autoSwitch.runNow": "立即检测",
  "proxies.autoSwitch.targetGroup": "生效代理组",
  "proxies.autoSwitch.activeInterval": "当前节点检测间隔",
  "proxies.autoSwitch.standbyInterval": "备用节点检测间隔",
  "proxies.autoSwitch.maxDelay": "最大可接受延迟",
  "proxies.autoSwitch.failureThreshold": "连续失败次数",
  "proxies.autoSwitch.cooldown": "切换冷却时间",
  "proxies.autoSwitch.closeConnections": "切换后关闭现有连接",
  "proxies.autoSwitch.regionPreview": "地区识别预览",
  "proxies.autoSwitch.unknown": "未识别"
}
```

英文文件使用对应英文短句。

- [ ] **Step 2: 运行全量检查**

Run:

```bash
pnpm run format:check && pnpm run lint:check && pnpm run typecheck
```

Expected: 命令退出码为 0；既有 warning 可记录但不应新增 error。

- [ ] **Step 3: 手动验收**

本地启动应用后检查：

1. 自动切换默认关闭。
2. 打开弹窗能选择目标代理组。
3. 修改地区关键词后识别预览变化。
4. 点击立即检测后状态条刷新。
5. 设置较低 `maxDelayMs` 后，当前节点连续失败达到阈值时自动切换。
6. 同地区无可用节点时切到下一地区。
7. 关闭自动切换后 timer 停止。

## 自审清单

- 用户目标覆盖：已覆盖定时测速、当前节点高频检测、异常及时切换、地区优先级、可配置地区、傻瓜 UI。
- 代码边界正确：复用 `mihomoGroups()`、`mihomoProxyDelay()`、`mihomoChangeProxy()`、`mihomoCloseAllConnections()`。
- provider 正确：候选对象保留 `provider`，测速调用传第三参。
- IPC 正确：主进程、renderer wrapper、preload 白名单都列入计划。
- 启动时机正确：在 Mihomo core 启动成功后启动，不在 IPC 注册后启动。
- 不过度设计：删除 `timeoutMs`、双阈值、自动切回、历史记录、导入导出、每地区阈值。
- 本地开发约束：计划不包含 commit/push 步骤。
