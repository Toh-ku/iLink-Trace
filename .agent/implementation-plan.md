# Implementation Plan

## Current Phase

**P0 — 接入可行性验证。**

在 P0 的出口条件全部满足前，不应投入完整 UI、正式数据库 Schema 或完整重放实现。允许建立最小 workspace、simulator、代理 spike 和测试基础设施。

## P0：接入可行性验证

目标：证明至少一个测试客户端可以稳定通过 Trace 完成文本消息链路。

任务：

- [ ] 建立 pnpm workspace、Node 24、TypeScript ESM 基础配置。
- [ ] 建立 `packages/testkit` 上游 simulator，禁止连接真实微信。
- [ ] 实现最小代理 spike：方法、路径、headers、body 透明转发。
- [ ] 验证 35 秒级长轮询不会被本地超时提前中止。
- [ ] 验证客户端断连能取消上游请求。
- [ ] 模拟 `get_qrcode_status` 的 `baseurl` 改写。
- [ ] 模拟 `scaned_but_redirect` / `redirect_host`。
- [ ] 完成一条文本链路：`getupdates → getconfig → sendtyping → sendmessage`。
- [ ] 输出客户端接入矩阵：bootstrap、existing-session、需要 adapter。

出口条件：

- 三平台中的至少 Linux 和 Windows 集成测试通过。
- 没有请求体/响应体破坏、Content-Length 错误或长轮询提前超时。
- 上游目标不能由入站 Host 任意控制。
- 结论和已知限制写入 `docs/`。

## M0：Capture Proxy

目标：形成可长期运行、不会因观测失败影响 Bot 的记录代理。

任务：

- [ ] 实现 data plane 和 control plane 双端口。
- [ ] 实现 Account Registry 与 token HMAC 指纹。
- [ ] 实现有界 Recorder 队列和降级事件。
- [ ] 实现 Storage Worker、SQLite WAL 和 migration runner。
- [ ] 建立 `accounts`、`http_exchanges`、`payloads` 基础表。
- [ ] 实现 payload 上限、截断、hash 和 header 脱敏。
- [ ] 实现 health、accounts、exchanges REST API。
- [ ] 实现保留期清理。

出口条件：

- 数据库故障时代理仍能透明转发。
- 负载测试证明队列和 body 捕获有上限。
- token、Authorization 和二维码凭据泄漏测试通过。
- Windows、Linux、macOS 安装和 `better-sqlite3` 加载通过。

## M1：Protocol Trace

目标：从原始 HTTP exchange 生成可解释、可重建的协议事件和消息 trace。

任务：

- [ ] 建立 parser registry、parser version 和 fixture 规范。
- [ ] 实现核心 Bot API parser。
- [ ] 增加 `protocol_events`、`message_traces`、`trace_spans`。
- [ ] 实现 `context_token`、`run_id`、`client_id` 关联。
- [ ] 实现关联可信度。
- [ ] 实现离线 reparse。
- [ ] 区分网络、HTTP、JSON 和业务成功状态。

出口条件：

- 每个 parser 有正常、缺字段、未知字段和错误响应 fixture。
- reparse 不修改原始 exchange。
- 不把 `ret: 0` 描述为最终送达。

## M2：Vue Console

目标：提供实时、可定位问题的本地 Web UI。

任务：

- [ ] Vue 3、Vite、Router、Vue Query 基础骨架。
- [ ] Overview、Messages、Traces、Exchange Detail 页面。
- [ ] SSE 事件 ID、断线恢复和 cache invalidation。
- [ ] 虚拟列表。
- [ ] CSS Grid + SVG 时序视图。
- [ ] 明确展示截断、脱敏、记录降级和关联可信度。

出口条件：

- 大量 trace 下 DOM 和内存保持有界。
- SSE 断线后能恢复或触发全量刷新。
- 前端不展示服务端未确认的“已送达”。

## M3：Replay Sandbox

目标：安全重放文本消息，不触达真实微信服务。

任务：

- [ ] 持久化账号级 replay 状态机。
- [ ] 支持 queued、sandbox、draining、timeout、cancel。
- [ ] 模拟 getupdates/getconfig/sendtyping/sendmessage/notify。
- [ ] 阻断未知副作用端点。
- [ ] 实现保真重放和执行重放。
- [ ] 实现游标不变性检查。
- [ ] 实现旧回复/新回复和耗时对比。

出口条件：

- 测试网络层证明重放期间真实上游未收到任何副作用请求。
- 崩溃恢复不会补发捕获请求。
- 账号能在完成、取消和超时后回到 LIVE。

## M4：Export 与发布

目标：提供稳定导出格式和可重复安装方式。

任务：

- [ ] 版本化脱敏 JSON 导出。
- [ ] Vitest/Jest fixture 模板。
- [ ] npm CLI 打包 smoke test。
- [ ] Docker 镜像和非 root 运行。
- [ ] Windows/Linux/macOS 安装文档。
- [ ] 威胁模型、安全披露和数据清理文档。
- [ ] 获得发布授权后再增加 npm/Docker 发布 workflow。

出口条件：

- `pnpm pack --dry-run` 内容经过审计。
- 发布包不包含 fixture 中的敏感样本、开发数据库或本地配置。
- 新环境可以按 README 完成安装和本地 simulator 验证。
