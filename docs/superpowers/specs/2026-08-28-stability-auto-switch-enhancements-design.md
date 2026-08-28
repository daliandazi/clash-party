# Stability and Auto Switch Enhancements Design

## 背景

当前分支已经实现了可配置的代理自动切换：主进程定时检测当前节点和候选节点延迟，按地区优先级选择可用节点，并在 UI 中提供傻瓜配置。GitHub open issues 里仍有四类值得优先处理的问题：

- 休眠/长时间运行后网络失效：#1933、#1224、#159。
- 长时间运行内存上涨：#1976。
- 节点测速在特殊网络下全部超时或误判：#1507。
- 自动选择时缺少节点排除能力：#527，并覆盖 #1549 中“智能测速选点”的小范围诉求。

这次不做大重构，不实现下载分片负载均衡，不改 Mihomo 内核。目标是把现有自动切换从“能切换”增强为“长期运行可恢复、可观测、误判更少、配置更符合用户心智”。

## 目标

1. 应用从系统休眠恢复后，能自动检查当前代理状态，并在必要时触发自动切换或 core 重启。
2. 自动切换测速降低并发造成的假超时，尤其保护当前正在使用的节点检测。
3. 自动切换支持排除节点关键词或正则，避免选中香港、高倍率、特殊用途节点。
4. 添加轻量运行时诊断日志，为内存泄漏和进程异常退出提供证据。

## 非目标

- 不实现 HTTP Range 分片下载加速或跨节点并行负载均衡。
- 不接管 Mihomo 内核的 url-test/load-balance 策略组生成。
- 不解决所有 TUN 平台兼容问题；只做休眠恢复入口和保守恢复动作。
- 不默认开启会改变用户网络行为的新功能；自动切换仍需用户启用。

## 设计概览

新增一个主进程“运行时健康协调器”，负责系统 resume 后的恢复动作和周期性诊断采样。它不直接决定选哪个节点，而是复用现有 `autoProxySwitch` 服务。

自动切换服务新增三项能力：

- 节点排除规则：配置 `excludePatterns`，候选集构建时剔除命中的节点。
- 保守测速策略：自动切换使用独立并发上限 `delayConcurrency`，默认低于全局手动测速并发。
- 超时重试：自动切换候选节点在 timeout/异常时可低并发重试一次，减少并发或网络抖动带来的误判；当前正在使用的节点不重试，避免拖慢故障转移。

UI 保持“傻瓜配置”：在现有自动切换弹窗里增加“排除节点关键词/正则”和“检测并发”。预览区域显示地区分桶、未知节点和被排除节点。

## 数据结构

扩展 `IProxyAutoSwitchConfig`：

```ts
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

扩展 `IProxyAutoSwitchState`：

```ts
interface IProxyAutoSwitchState {
  running: boolean
  paused: boolean
  checkingActive: boolean
  checkingStandby: boolean
  currentGroup?: string
  currentProxy?: string
  currentRegion?: string
  consecutiveFailures: Record<string, number>
  lastDelays: Record<string, IProxyAutoSwitchDelayEntry>
  buckets: IProxyAutoSwitchBucket[]
  unknownProxies: string[]
  excludedProxies?: IProxyAutoSwitchExcludedProxy[]
  lastRecoveryAt?: string
  lastRecoveryAction?: 'resume-check-ok' | 'resume-core-restart'
  lastError?: string
}

interface IProxyAutoSwitchExcludedProxy {
  name: string
  pattern: string
}
```

新增 `IRuntimeDiagnosticsConfig` 可先作为 `IAppConfig.runtimeDiagnostics`，默认开启低频日志：

```ts
interface IRuntimeDiagnosticsConfig {
  enabled: boolean
  intervalSec: number
  logMemory: boolean
  logCoreState: boolean
}
```

默认值：

- `proxyAutoSwitch.delayConcurrency = 4`
- `proxyAutoSwitch.retryTimeoutOnce = true`
- `proxyAutoSwitch.excludePatterns = []`
- `runtimeDiagnostics.enabled = true`
- `runtimeDiagnostics.intervalSec = 300`
- `runtimeDiagnostics.logMemory = true`
- `runtimeDiagnostics.logCoreState = true`

## 休眠恢复流程

`src/main/lifecycle.ts` 监听 `powerMonitor.on('resume')`，调用运行时健康协调器：

1. 记录 resume 事件。
2. 等待固定 5 秒，让系统网络栈恢复。
3. 调用 `runAutoProxySwitchCheck('active')`。
4. 如果自动切换状态显示当前节点可用或成功切换，结束。
5. 如果 core 不可用、目标组不存在、没有可用候选节点，调用 `restartCore(true)` 做一次强制恢复。
6. 恢复动作设 60 秒冷却，避免唤醒时网络反复抖动导致重启风暴。

恢复协调器只处理“应用层恢复策略”，不内嵌地区/节点选择逻辑。

## 测速可靠性

自动切换不再直接使用全局 `delayTestConcurrency`。全局并发是用户手动测速体验参数，不适合后台故障判断。后台使用：

```ts
const concurrency = clamp(config.delayConcurrency, 1, 20)
```

当前节点检测始终单节点执行，不参与批量并发，也不做 timeout 重试。这个取舍是为了保证当前节点出问题时尽快累计失败并触发切换；误判风险由连续失败阈值吸收。

候选节点如果一次测速返回 `delay <= 0` 或抛错，且 `retryTimeoutOnce` 为 true，服务会对该节点立即重试一次。已返回明确高延迟的节点不重试，避免大量慢节点放大后台检测耗时。这样能覆盖 #1507 中“高并发导致全部超时，低并发可测通”的问题，同时不会无限重试。

## 节点排除规则

复用现有 pattern 语义：

- 普通字符串：大小写不敏感包含匹配。
- `/.../flags`：正则匹配。
- 无效正则：不生效，并在 UI 保存前提示。

候选节点进入地区分桶前先执行排除匹配。被排除节点不参与 `candidates`，不被测速，不会被自动切换选中。状态中保留 `excludedProxies`，UI 预览展示“排除数量”和命中的规则，避免误解。

## 运行时诊断

新增 `src/main/core/runtimeHealth.ts`：

- 周期性记录主进程内存：`process.memoryUsage()`。
- 记录 core 是否存在：复用 `hasCoreProcess()`。
- 记录自动切换状态摘要：当前组、当前节点、连续失败数量、最后错误。
- 监听 renderer crash/gone 事件可继续由现有 window 逻辑处理，本次只补充日志入口，不做 crash reporter。

诊断日志走现有 logger，默认 300 秒一次。日志必须短小，不能 dump 大对象，避免诊断功能本身导致日志膨胀。

## UI 变更

在 `src/renderer/src/components/proxies/auto-switch-modal.tsx` 增加：

- “后台检测并发”：number input，范围 1-20，默认 4。
- “失败后重试一次”：switch，默认开启。
- “排除节点”：textarea，支持逗号/中文逗号/换行分隔。
- 预览中展示：
  - 地区分桶节点数量。
  - 未识别节点。
  - 被排除节点和命中规则。

不新增页面，不新增复杂向导。

## 测试策略

单元测试优先，手动验证只用于 Electron 启动和打包：

- `autoProxySwitch.test.ts`
  - normalize 新字段默认值和边界。
  - normalize 能容忍旧配置中的坏 region 条目，不让后台服务崩溃。
  - excludePatterns 会剔除候选节点并记录 excludedProxies。
  - 无效正则不会导致服务崩溃。
  - delayConcurrency 控制后台测速并发。
  - retryTimeoutOnce 能把候选节点第一次 timeout、第二次成功判为可用；显式关闭时不重试；当前节点不重试。
  - restart/stop/start 定时器有 generation 隔离，旧检查不会在新运行周期重复注册 timer。

- `runtimeHealth.test.ts`
  - 启动后按 interval 调用 logger。
  - stop 后不再调度。
  - 日志内容只包含摘要字段。
  - resume 后调用恢复协调器。
  - 冷却期内不会重复恢复。

最终验证：

```bash
pnpm test
pnpm run review
pnpm run build:linux
```

## 风险和边界

- 系统 resume 后网络可能需要更久恢复。本轮固定等待 5 秒；指数退避网络探测状态机不纳入本轮范围，需要另开设计。
- 内存泄漏不能靠本次直接修复。先建立可观测性，否则容易做无效重构。
- 排除规则过强可能导致没有可用候选节点。UI 必须显示被排除数量和最后错误。
- 自动切换默认关闭，避免升级后用户网络行为变化。

## 验收标准

1. 开启自动切换后，当前节点连续失败会先按地区优先级切换；没有候选时才进入恢复/重启路径。
2. 自动切换候选集不会包含命中排除规则的节点。
3. 后台测速并发默认是 4，且可在 UI 配置。
4. resume 事件触发一次恢复检查，并受冷却保护。
5. 周期性诊断日志可看到 main 内存和 core 状态摘要。
6. `pnpm test`、`pnpm run review`、`pnpm run build:linux` 均通过。
