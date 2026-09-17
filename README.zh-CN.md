# DSH 公司网关与重试插件

[English README](README.md)

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供公司网关模型发现和有限次数重试，已验证 **DSH 0.1.5-rc.1**。0.2.0 改为使用 DSH 原生 provider retry policy 和 session projections，无 Matrix Skin 依赖、样式、浏览器脚本、全局启动包装或个人绝对路径。

插件只管理 `llm-pi-ai.providers.myhexin-office`。DeepSeek 官方 API 保留出厂模型列表、Effort 选项与重试行为；其他 provider、默认模型选择和已有对话不变。公司插件和 Matrix Skin 可以独立安装、同时使用。

## 安装与升级

需要 Node.js 20+、DSH 0.1.5-rc.1 或保留兼容 settings API 的新版、标准 `llm-pi-ai` 适配器与内置 `llm-retry`。

```bash
# 使用 DSH 插件管理器，同时完成 bundle 配置同步：
dsh plugin --profile web add -w /path/to/dsh-office-llm-retry
```

包通过 `dsh.bundle` 声明 `cordis.patch.yml`。**必须保留内置 `llm-retry` 启用**。从 0.1.0 升级时，删除以前的 `id: llm-retry / disabled: true` 覆盖。本插件已不再监听 `agent/request-error`，不会叠加第二套重试。旧版手动安装还应确认：包位于 profile 的 `dependencies`（仅在 `devDependencies` 中不足以被识别），包名已加入 `dsh.profile.bundles`。bundle 提供插件条目后，把旧的 `dsh-llm-retry-capped` 手动 `insert` 改为下文仅按 ID 覆盖的配置，避免同一插件插入两次。单独执行 `pnpm add` 不会完成 DSH bundle 同步。

## 启用公司网关发现

在 DSH 凭据服务中保存 `MYHEXIN_OFFICE_API_KEY`，不要把实际 key 写入插件或配置。修改 profile patch 的插件条目：

```yaml
- id: dsh-llm-retry-capped
  config:
    provider: myhexin-office
    maxRetries: 200
    initialDelayMs: 500
    maxDelayMs: 10000
    jitterRatio: 0.1
    gateway:
      enabled: true
      verifyEfforts: true
      verifyAvailability: false
      refreshIntervalMs: 900000
```

也可以在 DSH 的 `dsh-office-llm-retry` settings namespace 中配置。发现功能默认关闭；没有公司路由时，仅安装插件不会添加公司 provider，需要显式启用发现并存在公司凭据。对于已经识别的公司路由，插件仍会配置专属重试策略。

启用后使用公司门户的新地址：

- 模型列表：`https://aigw-office.myhexin.com/ai-gateway/models`
- 推理接口：`https://aigw-office.myhexin.com/ai-gateway/v1/chat/completions`

插件会迁移已识别的旧地址 `https://aimemodeldev.myhexin.com/litellm/v1`。已有路由必须同时满足公司 provider ID、已知新旧端点、`openai-completions` 协议和公司凭据引用，才会被管理；用户把同名路由改成其他服务后，不会覆盖它。发现过程中端点、凭据引用或 key 改变，旧结果会丢弃。

## 模型与 Effort

发现会在启动后异步执行。日志只记录目录读取、可用性检查、Effort 检查阶段及最终数量；下拉菜单在验证完成后更新。若 pi-ai 的 settings namespace 稍后才注册，插件会等待本地依赖就绪，不会反复发起网络探测。

下拉菜单跟随 `/models`。Effort 只接受模型列表明确提供的元数据，或网关验证返回的确切支持等级，不再按模型名字猜测。`verifyEfforts: true` 时，缺少元数据会执行 `max_tokens: 1` 的有界验证探测。如果服务静默接受非法参数，不能据此认定支持某些等级：未经证实的 Effort 选项隐藏。静默接受参数的服务可能产生极小的实际响应。

能力缓存位于 settings 文件旁的 `cache/office-gateway-capabilities.json`，不含 API key，只绑定端点与凭据哈希。已证实能力缓存 24 小时，未证实或拒绝访问的结果会更早重查。启动、公司凭据更新及定时间隔会刷新目录；`refreshIntervalMs: 0` 关闭定时刷新。`verifyAvailability: true` 额外执行有界真实推理检查（每次最多 256 输出 token），排除无法完成推理的路由。默认 `false` 仅核对目录、Effort 与鉴权证据，不证明端到端推理可用。若希望启动时核验可用性而不定时重复探测，使用 `verifyAvailability: true` 加 `refreshIntervalMs: 0`。该检查可能按每个广告模型消耗少量 token。

目录请求失败时保留上次公司目录。明确返回无权限的模型会排除。目录为空或全部无权限时，只移除公司路由以隐藏失效模型（DSH 不接受空的自定义目录），之后发现恢复可用模型会重新创建路由。凭据和用户默认模型设置保留；若默认模型已不可用，需要先选择可用模型。

## 重试策略

| 配置项 | 默认值 | 含义 |
|---|---:|---|
| `maxRetries` | `200` | 初始请求之后的可重试次数，`0` 关闭公司重试。 |
| `initialDelayMs` | `500` | 指数退避初始等待毫秒数。 |
| `maxDelayMs` | `10000` | 最大等待时间；服务要求更长 Retry-After 时遵循原生终止行为。 |
| `jitterRatio` | `0.1` | 对称抖动比例，范围 0 到 1。 |
| `retryableCodes` | 见下文 | 公司重试策略接受的失败类型。 |

默认失败类型：`EMPTY_RESPONSE`、`RATE_LIMIT`、`SERVER`、`TIMEOUT`、`TRANSPORT`、`STREAM_CLOSED`、`PI_AI_ERROR`。与 0.1.0 不同，本版不会自动重试永久鉴权或配置错误，也不再作用于所有 provider。需要时可显式添加其他失败类型。重试可能再次消耗输入 token。

计数持久化、流式恢复、取消和卸载均由 DSH 内置重试执行器负责。只有一个执行器，达到 200 次不会进入另一套预算。移除插件会停止后续同步，已保存的公司 provider 配置仍可在 DSH 中编辑。

## 开发验证

```bash
pnpm install
pnpm test
# 使用实际安装的 DSH 原生重试执行器做集成验证：
DSH_RUNTIME_MODULES=/path/to/dsh/node_modules pnpm test
```

覆盖官方隔离、端点/凭据并发变化、能力验证、缓存、取消、空目录、原生 projection 重试上限和官方默认五次重试。未提供 `DSH_RUNTIME_MODULES` 时跳过上游集成测试。

## 许可证

MIT
