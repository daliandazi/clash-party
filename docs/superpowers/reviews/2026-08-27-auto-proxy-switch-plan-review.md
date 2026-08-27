# 自动延迟检测与地区兜底切换方案审查

## 最终结论

修订后的方案达到用户目标，可以作为本地开发依据。原方案方向正确，但存在实现级错误和过度设计；已在 spec 和 plan 中修正。

核心判断：

- 应开发。当前项目没有后台定时测速和自动切换闭环。
- 应放在应用层主进程做，不改 Mihomo 内核、不改订阅源。
- UI 需要支持，而且必须包含地区识别预览，否则不算傻瓜配置。
- 首版必须保留 active 高频检测、standby 低频检测、连续失败阈值、切换冷却、地区优先级。
- 首版应删除自动切回、独立 timeout、active/standby 双阈值、历史记录、导入导出、每地区阈值。

## 对照用户目标

| 用户目标               | 修订后方案                             | 审查结论 |
| ---------------------- | -------------------------------------- | -------- |
| 定时自动测试延迟       | active timer + standby timer           | 覆盖     |
| 当前使用节点更高频检测 | active 每 15 秒只测当前节点            | 覆盖     |
| 节点异常及时切换       | 连续失败 2 次触发切换，默认约 30 秒    | 覆盖     |
| 同地区优先，跨地区兜底 | 按地区优先级和可用延迟选择             | 覆盖     |
| 地区可配置             | regions 支持增删改、启用、排序、关键词 | 覆盖     |
| UI 傻瓜配置            | 状态条 + 弹窗 + 识别预览 + 立即检测    | 覆盖     |

## 结合代码的证据

### 1. 现有 Mihomo API 足够支撑能力

`src/main/core/mihomoApi.ts` 已经提供：

- `mihomoGroups(includeHidden)`：获取运行态代理组。
- `mihomoProxyDelay(proxy, url, provider)`：单节点测速。
- `mihomoChangeProxy(group, proxy)`：切换节点。
- `mihomoCloseAllConnections()`：关闭连接。

所以不需要重写网络探测，不需要直接编辑 Mihomo 配置文件。

### 2. provider 信息必须保留

代理页已有逻辑：

```ts
mihomoProxyDelay(proxy.name, groups[index].testUrl, getProviderName(proxy))
```

`mihomoProxyDelay()` 在 provider 存在时走：

```ts
;/providers/eioprsx / { provider } / { proxy } / healthcheck
```

因此后台候选不能只是 `string[]`，必须至少是：

```ts
interface AutoSwitchCandidateProxy {
  name: string
  provider?: string
  regionId?: string
}
```

否则 provider 节点会走错测速 API。

### 3. 独立 `timeoutMs` 是无效设计

`mihomoProxyDelay()` 当前只读取全局：

```ts
delayTestUrl
delayTestTimeout
```

如果新增 `proxyAutoSwitch.timeoutMs` 但不改 `mihomoProxyDelay()`，这个字段不会生效。修订方案删除独立 timeout，复用现有全局 `delayTestTimeout`，这是更小、更一致的方案。

### 4. active 不能被 standby 阻塞

用户明确要求当前节点检测密度更高，目的是及时切换。原 plan 的单个全局 `checking` 会导致 standby 批量测速期间 active 直接跳过。

修订方案改为：

- `checkingActive`
- `checkingStandby`
- active 不等待 standby。
- standby 如果遇到 active 正在执行，可以跳过本轮。

这个设计符合“当前节点优先”的本质目标。

### 5. preload 白名单是硬边界

`src/preload/index.ts` 有 invoke/listen channel 白名单。新增 IPC 如果只改 main 和 renderer，不改 preload，会在 renderer 侧被拒绝。

修订计划已明确加入：

- `getAutoProxySwitchState`
- `restartAutoProxySwitch`
- `runAutoProxySwitchCheck`
- `autoProxySwitchUpdated`

### 6. 启动时机必须在 core 启动成功后

自动切换依赖 Mihomo API。`src/main/index.ts` 中 profile updater、WebDAV scheduler 已经在 core 启动成功后初始化，自动切换应放在同一阶段。

不能在 IPC 注册后立即启动，否则 core 未就绪时会产生无意义错误或错误 paused 状态。

## 过度设计删除项

已从修订方案删除：

- `restorePreferredRegion`
  - 自动切回会扰动长连接，容易造成来回跳，首版不做。
- `timeoutMs`
  - 复用全局 `delayTestTimeout`。
- `activeMaxDelayMs` / `standbyMaxDelayMs`
  - 首版一个 `maxDelayMs` 足够，用户认知成本低。
- 每地区独立阈值
  - 增加 UI 和决策复杂度，首版收益不高。
- 历史切换记录
  - 状态条和日志足够首版验收。
- 导入导出模板
  - 非核心闭环。
- 自动支持 smart 组
  - `mihomo-smart` 有自己的策略行为，首版只提示不推荐选择。
- commit 步骤
  - 用户明确要求本地开发不提交。

## 最小正确方案

### 配置

```ts
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

### 默认策略

- 当前节点检测：15 秒。
- 备用节点检测：300 秒。
- 最大延迟：800ms。
- 连续失败：2 次。
- 切换冷却：180 秒。
- 切换后关闭连接：开启。

这组默认值意味着当前节点持续异常时约 30 秒触发切换，且只高频检测当前节点，不会把后台测速做重。

### 切换决策

1. 当前节点 active 检测失败计数达到阈值。
2. 未处于冷却期。
3. 按地区优先级找候选。
4. 当前地区无可用节点，再找下一个地区。
5. 缓存过旧时按地区即时补测，不全量扫所有地区。
6. 选择延迟最低的可用节点。
7. 切换后按配置关闭连接。

## 仍需开发时注意的风险

1. `getProviderName()` 目前在 renderer 代理页使用，主进程不能直接依赖 renderer 函数；主进程需要自己读取 `proxy['provider-name']`。
2. `IMihomoMixedGroup.all` 里可能包含 group 类型和 proxy 类型，后台应过滤掉不适合切换的特殊节点，如 `DIRECT`、`REJECT`，并避免选回当前节点。
3. standby 批量测速可能很慢，必须限并发并允许被 active 抢占。
4. 保存配置前要校验正则，否则一个错误 pattern 会让后台服务持续报错。
5. `patchAppConfig()` 深合并数组的具体行为要确认；如果数组不是替换语义，保存 `regions` 时可能需要特殊处理。

## 自审结论

修订后的方案不是过度设计，是达成目标所需的最小闭环：

- 没有后台 scheduler，就无法定时自动测速。
- 没有 active 高频检测，就无法及时发现当前节点故障。
- 没有 standby 缓存和即时补测，就无法可靠选择可用候选。
- 没有地区优先级，就无法表达“美国优先、日本兜底”。
- 没有 UI 识别预览，就无法让普通用户正确配置地区规则。

因此建议按修订后的 plan 进入本地开发；不要按原始 plan 直接实现。
