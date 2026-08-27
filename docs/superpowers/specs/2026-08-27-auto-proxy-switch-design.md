# 自动延迟检测与地区兜底切换设计 Spec

## 结论

Clash Party 当前支持手动测速、手动切换节点、全局测速 URL/超时/并发配置，但不支持“后台定时测速 + 当前节点高频健康检查 + 按地区优先级自动切换”的闭环。

首版应在应用层新增一个主进程后台服务 `autoProxySwitch`，复用现有 Mihomo API，不改 Mihomo 内核、不改订阅源、不生成复杂策略组。UI 只提供用户能理解的傻瓜配置：开关、目标代理组、检测频率、最大延迟、连续失败次数、地区优先级和识别预览。

## 用户目标

1. 定时自动测试节点延迟。
2. 当前正在使用的节点要更高频检测，发现不可用或高延迟后及时切换。
3. 当前节点异常时，优先切换到同地区可用且延迟低的节点。
4. 同地区都不可用或延迟都高时，按配置优先级切到下一个地区，例如美国不可用后切日本。
5. 地区不是写死的，默认模板可以有美国、日本等，但用户必须能配置、排序、删除、新增。
6. UI 要傻瓜化，用户不需要手写 YAML 或理解 Mihomo 策略组细节。

## 代码现状

已有能力：

- `src/main/core/mihomoApi.ts`
  - `mihomoGroups(includeHidden)`：获取运行态代理组，`IMihomoMixedGroup.all` 已展开为代理对象。
  - `mihomoProxyDelay(proxy, url, provider)`：单节点测速。
  - `mihomoGroupDelay(group, url)`：代理组测速。
  - `mihomoChangeProxy(group, proxy)`：切换代理组当前节点。
  - `mihomoCloseAllConnections()`：关闭连接。
- `src/renderer/src/pages/proxies.tsx`
  - 已有手动逐节点测速、批量测速、手动切换、切换后关闭连接。
  - provider 节点测速通过 `getProviderName(proxy)` 传入 `mihomoProxyDelay()`。
- `src/renderer/src/components/settings/mihomo-config.tsx`
  - 已有全局 `delayTestUrl`、`delayTestTimeout`、`delayTestConcurrency` 配置。
- `src/main/config/app.ts`
  - `getAppConfig()` 会把默认配置深合并到现有配置并落盘。
  - `patchAppConfig()` 是当前配置写入路径。
- `src/preload/index.ts`
  - IPC invoke/listen channel 有白名单；新增 IPC 必须同步加入。
- `src/main/index.ts`
  - profile updater、WebDAV scheduler 等后台任务在 Mihomo core 启动成功后初始化；自动切换也必须走同样启动时机。

缺口：

- 没有后台 scheduler。
- 没有 active 当前节点高频检测。
- 没有 standby 备用节点低频检测。
- 没有地区匹配和节点分桶。
- 没有连续失败计数、冷却时间、防抖。
- 没有自动切换状态展示和识别预览。

## 非目标

首版不做以下能力：

- 不自动生成或改写订阅源 YAML。
- 不修改 Mihomo 内核。
- 不依赖 `mihomo-smart`，也不优先支持 smart 组自动切换。
- 不做高优先级地区恢复后自动切回。
- 不做历史切换记录、模板导入导出、每地区独立阈值。
- 不新增单独测速超时字段，复用现有全局 `delayTestTimeout`。

## 推荐架构

新增主进程服务：

```text
Renderer UI
  ├─ 修改 IAppConfig.proxyAutoSwitch
  ├─ 请求当前状态 / 立即检测
  └─ 展示识别预览和运行状态

Preload IPC whitelist
  ├─ getAutoProxySwitchState
  ├─ runAutoProxySwitchCheck
  ├─ restartAutoProxySwitch
  └─ autoProxySwitchUpdated

Main autoProxySwitch service
  ├─ active timer：高频检测当前节点
  ├─ standby timer：低频检测候选节点
  ├─ 地区匹配、延迟缓存、失败计数
  └─ 调用 Mihomo API 切换节点 / 关闭连接

Mihomo API
  ├─ mihomoGroups(true)
  ├─ mihomoProxyDelay(name, testUrl, provider)
  ├─ mihomoChangeProxy(group, proxy)
  └─ mihomoCloseAllConnections()
```

这个方案的关键边界：决策在 Clash Party 应用层，实际测速和切换仍由 Mihomo API 执行。

## 配置模型

首版配置只保留必要字段：

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
```

默认值：

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

默认地区只是模板，不是业务写死；用户可以在 UI 里修改名称、关键词、顺序和启用状态。

## 运行态模型

```ts
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

内部候选对象必须保留 provider：

```ts
interface AutoSwitchCandidateProxy {
  name: string
  provider?: string
  regionId?: string
}
```

原因：provider 节点需要走 `/providers/proxies/{provider}/{proxy}/healthcheck`，只保留节点名会导致测速路径错误。

## 检测和切换规则

### 节点分桶

1. 调用 `mihomoGroups(true)` 获取运行态代理组。
2. 找到 `targetGroup`。
3. 从目标组 `all` 里读取候选节点对象。
4. 使用 `proxy['provider-name']` 保存 provider。
5. 按 `regions[].patterns` 匹配节点名。
6. 普通字符串使用大小写不敏感包含匹配。
7. `/.../flags` 格式按正则匹配。
8. 一个节点命中多个地区时，归属优先级更高的地区。
9. 未命中节点进入 `unknownProxies`，首版默认不参与自动切换，但在 UI 预览中展示。

### active 当前节点高频检测

1. 每 `activeIntervalSec` 秒只检测目标组当前节点。
2. active 检测不能被 standby 批量检测阻塞。
3. 当前节点 `delay` 缺失、为 0、异常、或超过 `maxDelayMs` 都视为一次失败。
4. 连续失败达到 `failureThreshold` 后进入切换流程。
5. 成功检测会清零当前节点连续失败计数。

默认 `activeIntervalSec=15`、`failureThreshold=2`，意味着约 30 秒内发现问题并触发切换，成本可控。

### standby 备用节点低频检测

1. 每 `standbyIntervalSec` 秒刷新候选节点延迟缓存。
2. standby 执行中如果 active 正在执行，可以跳过或让出；反过来不允许 standby 阻塞 active。
3. 并发使用现有 `delayTestConcurrency`，后台服务内部上限压到 20，避免后台扫太猛。
4. standby 只更新缓存，不主动切换，除非 active 已经判定当前节点失败。

### 切换流程

1. 检查自动切换开启、目标代理组存在、当前模式不是 direct。
2. 检查切换冷却时间，冷却期内不切换。
3. 按地区优先级逐个地区扫描候选。
4. 对当前地区候选使用缓存；缓存不存在或过旧时，只对该地区做即时补测。
5. 在当前地区选择 `delay > 0 && delay <= maxDelayMs` 中延迟最低的节点。
6. 如果当前地区没有可用节点，进入下一个地区。
7. 找到候选且候选不是当前节点时，调用 `mihomoChangeProxy(targetGroup, candidate.name)`。
8. `closeConnectionsOnSwitch=true` 时调用 `mihomoCloseAllConnections()`。
9. 更新 `lastSwitchAt`、`lastSwitchReason`、状态并通知 UI。

## UI 设计

入口：代理组页面增加“自动切换”入口和状态条。

状态条示例：

```text
自动切换：运行中 ｜ 组：PROXY ｜ 当前：US-01 ｜ 地区：美国 ｜ 最近检测：128ms ｜ 下次检测：12s
```

异常示例：

```text
自动切换：已暂停 ｜ 原因：目标代理组不存在
```

配置弹窗首版必须包含：

- 自动切换开关。
- 目标代理组下拉。
- 当前节点检测间隔。
- 备用节点检测间隔。
- 最大延迟。
- 连续失败次数。
- 切换冷却时间。
- 切换后关闭连接。
- 地区列表：新增、删除、改名、启用/禁用、上移、下移。
- 每个地区的匹配关键词。
- 识别结果预览。
- 立即检测。
- 恢复默认模板。

识别预览是傻瓜配置的关键：

```text
美国：US-01, 美国-02
日本：JP-01
未识别：Premium-01, Game-02
```

没有识别预览，用户无法判断规则是否配置正确。

## IPC

主进程注册：

```ts
getAutoProxySwitchState(): IProxyAutoSwitchState
runAutoProxySwitchCheck(reason?: 'manual' | 'active' | 'standby'): Promise<IProxyAutoSwitchState>
restartAutoProxySwitch(): Promise<IProxyAutoSwitchState>
```

事件：

```ts
autoProxySwitchUpdated(state: IProxyAutoSwitchState)
```

必须同步修改：

- `src/main/utils/ipc.ts`
- `src/renderer/src/utils/ipc.ts`
- `src/preload/index.ts`
- 必要时 `src/preload/index.d.ts`

## 启动和生命周期

- `registerIpcMainHandlers()` 只负责注册 IPC，不启动自动切换。
- `autoProxySwitch` 应在 Mihomo core 启动成功后启动。
- core 未启动或 mode 为 `direct` 时，服务进入 paused 状态并显示原因。
- 配置变更后调用 `restartAutoProxySwitch()` 重新加载 timer。
- app 退出前停止 timer，避免悬挂任务。

## 错误处理

- 目标代理组不存在：paused，UI 显示原因。
- 目标组无节点：paused 或 lastError，不切换。
- 所有地区无可用节点：保持当前节点，记录原因。
- 当前节点地区无法识别：仍检测，失败后按地区优先级选候选。
- 正则非法：配置保存前拦截；运行时也要忽略非法 pattern 并记录错误。
- Mihomo API 异常：计入失败，不单次切换。
- 切换失败：记录错误，进入冷却，避免频繁打 API。

## 测试策略

单元测试：

- `normalizeAutoSwitchConfig()` 补齐默认值并夹住非法数值。
- `compileRegionPattern()` 支持普通字符串和 `/regex/flags`。
- `classifyProxyRegion()` 多地区命中时按优先级归属。
- `buildRegionBuckets()` 保留 provider 信息，并输出 unknown。
- `chooseBestCandidate()` 优先同地区，失败后跨地区兜底。
- active 检测不被 standby 检测阻塞。
- 冷却期内不切换。
- 连续失败达到阈值才触发切换。

集成级 mock 测试：

- mock `mihomoGroups()`、`mihomoProxyDelay()`、`mihomoChangeProxy()`、`mihomoCloseAllConnections()`。
- 验证当前节点连续两次高延迟后切到同地区低延迟节点。
- 验证同地区全不可用后切到下一地区。
- 验证 provider 节点测速调用带 provider。
- 验证关闭功能后 timer 停止。

手动验收：

1. 选择目标代理组并打开自动切换。
2. 调低最大延迟，使当前节点连续失败。
3. 观察约 30 秒内切到同地区低延迟节点。
4. 让同地区节点全部不可用，观察切到下一地区。
5. 修改地区关键词，确认识别预览实时变化。
6. 关闭自动切换，确认 timer 停止、状态条显示已关闭。

## 自审结论

这个设计满足用户核心目标，且首版边界合理：

- 正确：复用现有 Mihomo API，符合项目现有手动测速/切换路径。
- 必要：后台服务、active/standby 双频、失败阈值、冷却、地区优先级都是需求闭环所需。
- 不过度：删除了自动切回、独立 timeout、双阈值、历史记录、导入导出、每地区阈值等二期功能。
- 风险可控：最重的 standby 批量测速低频且有限并发，active 高频只测当前节点。
