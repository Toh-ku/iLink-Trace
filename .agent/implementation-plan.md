# Implementation Plan

## Current Phase

**MVP 纵向切片 — 已实现本地代理、协议解析、控制台与文本重放；P0 客户端兼容性验证仍在进行。**

当前代码已经形成可运行的端到端 MVP，用于尽早验证产品交互。P0 中的真实客户端兼容性、长轮询时长和跨平台出口条件仍必须单独完成；已有 UI 和重放实现不代表这些条件已经通过。

## P0：接入可行性验证

目标：证明至少一个测试客户端可以稳定通过 Trace 完成文本消息链路。

任务：

- [x] 建立 pnpm workspace、Node 24、TypeScript ESM 基础配置。
- [ ] 建立 `packages/testkit` 上游 simulator，禁止连接真实微信。
- [x] 实现最小代理 spike：方法、路径、headers、body 透明转发。
- [ ] 验证 35 秒级长轮询不会被本地超时提前中止。
- [ ] 验证客户端断连能取消上游请求。
- [x] 实现 `get_qrcode_status` 的 `baseurl` 改写；仍需补充专用 simulator 验收。
- [x] 实现 `scaned_but_redirect` / `redirect_host` 路由；仍需补充专用 simulator 验收。
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

- [x] 实现 data plane 和 control plane 双端口。
- [x] 实现进程内 Account Registry 与 token HMAC 指纹；持久化 registry 待补。
- [x] 实现有界 Recorder 队列和降级事件。
- [x] 实现 Storage Worker、SQLite WAL 和初始 migration。
- [ ] 建立 `accounts`、`http_exchanges`、`payloads` 基础表。
- [x] 实现 payload 上限、截断和 header/body 脱敏；payload hash 待补。
- [x] 实现 health、overview、events、exchanges REST API；accounts API 待补。
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
- [x] 实现核心 Bot API parser。
- [x] 增加 `protocol_events`；完整 message trace/span 表待补。
- [x] 实现 `context_token` 精确关联；`run_id`、`client_id` 的跨事件关联待补。
- [x] 实现关联可信度字段。
- [ ] 实现离线 reparse。
- [ ] 区分网络、HTTP、JSON 和业务成功状态。

出口条件：

- 每个 parser 有正常、缺字段、未知字段和错误响应 fixture。
- reparse 不修改原始 exchange。
- 不把 `ret: 0` 描述为最终送达。

## M2：Vue Console

目标：提供实时、可定位问题的本地 Web UI。

任务：

- [x] Vue 3 + Vite 基础骨架；MVP 使用单页控制台，Router/Vue Query 延后。
- [x] 实现 Overview、事件时间线和 Exchange Detail；完整 Messages/Traces 页面待补。
- [x] 实现 SSE 事件 ID、浏览器重连和 REST 刷新。
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

- [x] 持久化 replay run，并在重启时把未完成任务标为失败。
- [x] 支持 queued、sandbox、draining、timeout、cancel。
- [x] 模拟 getupdates/getconfig/sendtyping/sendmessage/notify。
- [x] 阻断未知副作用端点。
- [x] 实现保真重放和执行重放。
- [x] 实现游标不变性单元检查。
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
