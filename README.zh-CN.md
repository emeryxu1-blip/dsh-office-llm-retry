# DSH 通用有限次数 LLM 重试插件

[English README](README.md)

这是一个面向 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) 的 provider 无关重试插件，为**所有已配置的 provider**提供可配置的有限重试预算。插件不包含特定 provider 名称、API 地址、API key 或网关专用逻辑，其他用户可以直接复用。

## 功能

插件监听 DSH 的 `agent/request-error` 请求失败边界，并重新执行完整的 agent step。因此它可以处理：

- 第一个响应 token 返回前发生的失败；
- 流式输出已经返回一部分后发生的失败；
- 多轮对话中后续 LLM step 的失败；
- 所有失败类型，包括连接/传输错误、超时、服务端错误、限流、协议错误和配置错误。

流式请求已经产生的失败片段不会被提升为持久化的 assistant 消息。下一次尝试会从持久化会话状态重新构造请求，因此模型收到的是相同的 prompt 和历史记录。

重试次数可以配置。**默认是在初始请求之外再重试 200 次**，最多产生 201 次 provider 调用。每个持久化的重试事件都会携带配置的 `maxRetries`，因此 DSH 界面会显示配置的预算，例如 `Retrying model request (1/200)`。达到配置的重试上限后，插件返回原始失败并终止当前 turn。

> 注意：重试可能重复消耗输入 token。永久性的鉴权错误或配置错误可能会消耗完整的重试预算。

## 环境要求

- Node.js 20 或更高版本；
- 支持 Cordis plugin loader 的 DSH；
- `@deepseek-ai/schemastery`（作为插件依赖会自动安装）；
- 一个或多个已经配置好的 DSH provider route。

## 安装

在 DSH profile 目录中执行：

```bash
pnpm add github:emeryxu1-blip/dsh-office-llm-retry
```

也可以使用发布包或本地 checkout：

```bash
pnpm add dsh-office-llm-retry
pnpm add /path/to/dsh-office-llm-retry
```

该包声明了 `dsh.bundle`，因此 DSH profile reconciliation 可以识别并激活它的 `cordis.patch.yml` 层。

## 配置

在 profile 的 `cordis.patch.yml` 中加入插件。应先禁用 DSH 内置的 retry 行，避免两个重试处理器同时工作：

```yaml
- id: llm-retry
  disabled: true

- insert:
    - id: dsh-llm-retry-capped
      name: 'dsh-office-llm-retry'
      config:
        maxRetries: 200
        initialDelayMs: 500
        maxDelayMs: 10000
        jitterRatio: 0.1
```

不需要填写 provider 名称、API 地址或 API key。插件会从 DSH 的每次失败请求中读取 provider 身份，并将相同的重试策略应用到所有 provider。

### 配置项

| 配置项 | 默认值 | 说明 |
|---|---:|---|
| `maxRetries` | `200` | 初始请求之后的重试次数，必须是非负整数。 |
| `initialDelayMs` | `500` | 本地退避的初始等待时间。 |
| `maxDelayMs` | `10000` | 本地退避的最大等待时间，同时限制可接受的 provider retry-after。 |
| `jitterRatio` | `0.1` | 对称退避抖动比例，范围为 0 到 1。 |

例如，只允许重试 20 次：

```yaml
config:
  maxRetries: 20
```

## 禁用 DSH 内置重试插件

DSH 的 standard bundle 已经包含 `@deepseek-ai/dsh-llm-retry`。它通常使用较小的 provider retry policy。如果使用本插件替代所有 provider 的重试逻辑，请保留以下配置：

```yaml
- id: llm-retry
  disabled: true
```

被禁用的内置条目仍可能出现在 DSH 的 Settings → Plugins 页面中，因为 DSH 会展示包括 disabled 条目在内的已配置 Loader entry。但它不会执行。

## 取消与运行行为

请求被 abort 或插件被卸载时，退避等待会立即取消。重试记录是持久化但不展示给模型的 session event，不会被加入模型 prompt。插件不包装直接的 `ctx.llm.stream()` 调用，而是在可以安全重放请求的 agent-loop 边界工作。

## 开发

```bash
pnpm install
pnpm test
```

## 许可证

MIT
