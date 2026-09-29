# iLink Trace Agent Guide

本文是所有自动化编码 Agent 在本仓库中的入口规则。开始任务前必须完整阅读本文，并按任务范围继续阅读 `.agent/` 中的文档。

## 1. 开始工作前

按以下顺序建立上下文：

1. 阅读 `docs/technical-design.zh-CN.md`，理解产品边界和已确认选型。
2. 阅读 `.agent/implementation-plan.md`，确认当前阶段和允许实施的范围。
3. 阅读 `.agent/architecture-guardrails.md`，确认数据面、安全和重放不变量。
4. 阅读 `.agent/verification.md`，在修改前确定必须执行的验证。
5. 检查工作区状态，保留用户和其他 Agent 已有的修改。

不要仅凭 issue 标题或局部代码猜测架构。如果任务与技术设计冲突，先在交付说明中指出冲突；涉及安全边界、公开 API、存储格式或技术栈变更时，不得静默偏离设计。

## 2. 项目使命

iLink Trace 是微信 iLink / ClawBot 协议的本地可观测代理与调试沙箱。它记录并解析 Bot API 流量、关联消息链路、通过 Vue UI 展示事件，并允许在不影响真实用户的前提下重放历史消息。

它不是 Bot 框架，不生成 AI 回复，不替代官方 SDK，也不实施 HTTPS MITM。

## 3. 固定技术方向

- 主要语言：TypeScript，必要的配置或构建脚本可使用 JavaScript。
- 运行时：Node.js 24 LTS。
- 模块系统：ESM。
- 包管理：pnpm workspace；版本必须在根 `package.json#packageManager` 中固定。
- 前端：Vue 3 + TypeScript + Vite。
- 数据面：Node 原生 HTTP/HTTPS 流与 `undici`。
- 控制面：Fastify REST + SSE。
- 存储：SQLite；首发驱动为 `better-sqlite3`，数据库访问位于 Worker Thread。
- 测试：Vitest；浏览器 E2E 使用 Playwright。
- 结构化日志：Pino，必须配置敏感字段脱敏。

未经明确的架构决策，不要把后端改为 Go/Rust/Python，不要把 Vue 改为 React，也不要把 SSE 改成 WebSocket。

## 4. 架构不变量

- 代理转发路径不能等待数据库、解析器、SSE 或前端。
- 数据面监听端口与控制面监听端口分离。
- 原始 HTTP exchange 与派生协议事件分开存储。
- 协议解析失败不得改变透明转发结果。
- 不允许根据入站 Host 任意选择上游；上游必须来自验证后的账号映射。
- 原始 `bot_token`、Authorization、二维码 token 不得进入数据库、普通日志、异常消息或测试快照。
- `context_token` 默认只保存 HMAC 指纹。
- 重放按账号隔离；MVP 每个账号同时最多一个 replay run。
- 重放期间对未知端点采取 fail closed，不得转发真实上游。
- 重放不得推进真实 `get_updates_buf`。
- HTTP 200、`ret: 0` 和最终用户收到消息是三个不同结论，UI 和日志不得混为一谈。
- 在没有 SDK 或 AI API 代理时，Bot 内部间隔必须称为 `unobserved processing gap`，不得伪装成 AI 耗时。

详细解释见 `.agent/architecture-guardrails.md`。

## 5. 目录和依赖边界

目标结构：

```text
apps/daemon       代理、控制 API、CLI、重放编排
apps/web          Vue Web Console
packages/protocol 协议类型、解析器、关联器和 fixtures
packages/contracts API/SSE 共享契约
packages/storage  SQLite repository、worker 和 migrations
packages/testkit  Bot/上游模拟器
docs              面向维护者和用户的设计文档
.agent            面向 Agent 的执行上下文
```

依赖方向：

```text
contracts ← protocol ← daemon
contracts ← web
storage   ← daemon
testkit   ← daemon/protocol 的测试
```

- `apps/web` 不得导入 daemon 内部模块。
- `packages/protocol` 不得依赖 Fastify、Vue 或具体 SQLite 驱动。
- `packages/contracts` 只能包含可序列化契约和纯类型/Schema。
- `packages/storage` 不得反向依赖 daemon。
- 跨包 API 必须从各包公开入口导出，禁止依赖其他包的 `src/` 私有路径。

## 6. 编码规则

- TypeScript 开启严格模式；不要用 `any` 绕过协议不确定性，未知网络数据先使用 `unknown`。
- 网络输入必须经过运行时 Schema 校验。
- 使用窄接口和显式依赖注入，不使用可变全局单例隐藏账号或重放状态。
- I/O 函数接受 `AbortSignal`，客户端断连必须能取消上游请求。
- 时间戳在持久层使用 UTC epoch milliseconds；UI 负责本地化显示。
- ID、消息序号和 SQLite INTEGER 可能超过 JS 安全整数时，使用 string 或 bigint，并在 API 边界序列化为 string。
- 协议字段只做必要归一化，原始 payload 必须可追溯。
- 新 parser 必须带稳定 `parser_id`、`parser_version` 和脱敏 fixture。
- 数据库变更只能通过新增 migration 完成；不要修改已经发布的 migration。
- 日志使用结构化字段；禁止拼接包含 headers、token 或完整消息正文的字符串。
- 注释说明“为什么”，不要复述代码本身。

## 7. 根脚本契约

工程骨架建立后，根 `package.json` 必须长期提供以下脚本，GitHub Actions 和 Agent 都依赖这些名称：

```text
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test:unit
pnpm test:integration
pnpm build
```

允许增加脚本，但修改或删除这些脚本前必须同步 CI 和本文。

## 8. 任务工作流

1. 确认任务属于当前里程碑，不主动实现后续阶段的大功能。
2. 先写或补充失败测试，再实现最小闭环。
3. 网络相关改动优先使用本地 simulator，禁止在自动测试中调用真实微信服务。
4. 涉及 token、上游路由、重放或导出的改动必须增加安全回归测试。
5. 完成后执行 `.agent/verification.md` 中与改动相称的检查。
6. 更新受到影响的文档、Schema、fixture 或 migration。
7. 最终报告说明变更、验证结果和仍存在的风险；不要声称没有验证过的行为已经可用。

## 9. 禁止事项

- 禁止把真实 token、消息、二维码或用户 ID 提交到仓库。
- 禁止在测试中访问真实 `ilinkai.weixin.qq.com` 或真实 CDN。
- 禁止为了让测试通过而关闭脱敏、TLS 校验、上游 allowlist 或 replay fail-closed。
- 禁止在主事件循环直接执行批量同步 SQLite 操作或媒体加解密。
- 禁止无上限缓冲请求体、响应体、SSE 队列或数据库写队列。
- 禁止把未知协议响应当作失败并改变代理结果；记录诊断后仍应透明转发。
- 禁止在没有发布授权、OIDC 配置和人工确认的情况下新增自动 npm/Docker 发布步骤。

## 10. 完成定义

一个任务只有在以下条件满足时才算完成：

- 行为符合技术设计和架构不变量。
- 正常路径、失败路径和取消路径均有测试或明确的人工验证记录。
- 没有新增明文凭据存储或日志泄漏。
- 相关根脚本通过；若无法运行，交付说明中必须给出具体原因。
- 用户可见行为和配置变更已更新文档。
- 没有把无关格式化或重构混入任务。
