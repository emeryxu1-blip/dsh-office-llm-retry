# DSH 办公网 LLM 重试插件

[English README](README.md)

这是一个面向 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) 的按提供方生效的模型请求重试插件，适用于办公网络中不稳定的模型网关，例如 MyHexin/LiteLLM。

## 功能

插件监听 DSH 的 `agent/request-error` 请求失败边界，并重新执行完整的 agent step。因此它可以处理：

- 第一个响应 token 返回前发生的失败；
- 流式输出已经返回一部分后发生的失败；
- 多轮对话中后续 LLM step 的失败；
- 所有失败类型，包括连接/传输错误、超时、服务端错误、限流、协议错误和配置错误。

流式请求已经产生的失败片段不会被提升为持久化的 assistant 消息。下一次尝试会从持久化会话状态重新构造请求，因此模型收到的是相同的 prompt 和历史记录。

重试次数可以配置。**默认是在初始请求之外再重试 200 次**，最多产生 201 次提供方调用。每个持久化的重试事件都会携带配置的 `maxRetries`，因此 DSH 界面会显示配置的预算，例如 `Retrying model request (1/200)`，而不是内置 provider 的重试预算。达到配置的重试上限后，插件返回原始失败并终止当前 turn。

> 注意：重试可能重复消耗输入 token。永久性的鉴权错误或配置错误可能会消耗完整的重试预算。

## 环境要求

- Node.js 20 或更高版本；
- 支持 Cordis plugin loader 的 DSH；
- `@deepseek-ai/schemastery`（作为插件依赖会自动安装）；
- 已配置好的 DSH provider route。

## 在 DSH profile 中安装

在 profile 目录中，将本仓库作为 Git 依赖安装：

```bash
pnpm add github:emeryxu1-blip/dsh-office-llm-retry
```

如果使用本地 checkout：

```bash
pnpm add /path/to/dsh-office-llm-retry
```

该包声明了 `dsh.bundle`，因此 `dsh plugin` 或 profile reconciliation 可以识别并激活它的 `cordis.patch.yml` 层。

## 配置插件

在 profile 的 `cordis.patch.yml` 中加入插件。应先禁用 DSH 内置的 retry 行，避免两个重试处理器同时工作：

```yaml
- id: llm-retry
  disabled: true

- insert:
    - id: office-llm-retry
      name: '@local/dsh-office-llm-retry'
      config:
        provider: myhexin-office
        maxRetries: 200
        initialDelayMs: 500
        maxDelayMs: 10000
        jitterRatio: 0.1
```

如果从 GitHub 安装后包管理器生成的包名不是 `@local/dsh-office-llm-retry`，请在配置中使用实际包名。

### 配置项

| 配置项 | 默认值 | 说明 |
|---|---:|---|
| `provider` | `myhexin-office` | 只对该 provider 的失败请求进行重试。 |
| `maxRetries` | `200` | 初始请求之后的重试次数，必须是非负整数。 |
| `initialDelayMs` | `500` | 本地退避的初始等待时间。 |
| `maxDelayMs` | `10000` | 本地退避的最大等待时间，同时限制可接受的 provider retry-after。 |
| `jitterRatio` | `0.1` | 对称退避抖动比例，范围为 0 到 1。 |

例如，只允许重试 20 次：

```yaml
config:
  provider: myhexin-office
  maxRetries: 20
```

## 配置办公网 provider

插件不保存也不读取 API key。请按照 DSH 的正常方式配置 provider，并通过环境变量名引用凭据：

```yaml
llm-pi-ai:
  providers:
    myhexin-office:
      displayName: MyHexin Office
      apiKeyEnv: MYHEXIN_OFFICE_API_KEY
      api: openai-completions
      baseURL: https://aimemodeldev.myhexin.com/litellm/v1
      timeoutMs: 600000
      streamIdleTimeoutMs: 600000
      models:
        - id: gpt-5.6-sol
          name: gpt-5.6-sol
```

请使用 DSH 的托管凭据机制或其他经过批准的密钥存储来保存 key。不要把 key 提交到 Git。

## 取消与运行行为

请求被 abort 或插件被卸载时，退避等待会立即取消。重试记录是持久化但不展示给模型的 session event，不会被加入模型 prompt。插件不包装直接的 `ctx.llm.stream()` 调用，而是在可以安全重放请求的 agent-loop 边界工作。

## 开发

```bash
pnpm install
node --test test/index.test.mjs
```

## 许可证

MIT
