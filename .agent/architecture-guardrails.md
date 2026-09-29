# Architecture Guardrails

本文把技术设计中的关键约束整理为实现时可检查的不变量。任何任务如果必须突破这些边界，都需要单独 ADR。

## 1. 数据面不能被观测面拖慢

代理主路径的职责仅限于：验证目标、转发、有限捕获和发布非阻塞记录任务。

以下操作不得位于响应返回前的必经路径：

- SQLite 写入或查询。
- 协议事件关联。
- SSE 广播。
- 前端状态更新。
- 大体积压缩、哈希或媒体加解密。

Recorder 使用有界队列。队列压力过高时按以下顺序降级：

1. 停止捕获完整 body，保留 metadata、大小和截断标记。
2. 合并低价值进度事件。
3. 发出 `recorder.degraded`。
4. 保持代理转发，不得静默阻断 Bot。

## 2. HTTP 透明性

- 删除 RFC 定义的 hop-by-hop headers。
- 修改 JSON body 后重新计算或移除 `Content-Length`。
- 客户端断连通过 `AbortSignal` 取消上游。
- 分别记录 DNS、连接、headers、body、客户端取消和业务错误。
- `getupdates` 与二维码状态轮询使用独立长轮询超时配置。
- 捕获上限只影响记录，不影响转发完整性。
- 协议解析或数据库失败不得替换真实上游响应。

## 3. 上游路由和 SSRF 边界

合法上游只能来自：

- 受信任登录响应中验证后的 `baseurl`。
- 受信任登录重定向中验证后的 `redirect_host`。
- 用户通过控制面显式登记且通过校验的地址。

必须拒绝：

- 非 HTTPS 上游。
- 带 userinfo 的 URL。
- loopback、link-local、私网 IP 和不允许的端口，除非测试环境通过依赖注入显式开启。
- 从请求 Host、Forwarded 或任意 query 参数直接生成的上游。
- DNS 解析前后绕过 allowlist 的目标。

测试 simulator 使用专用配置对象注入，生产默认值不能为了测试而放宽。

## 4. 敏感数据边界

永不持久化或记录：

- 原始 `Authorization`。
- 原始 `bot_token`。
- 二维码 token 和验证码。
- 控制面访问令牌。

默认指纹化：

- `context_token`。
- 用户 ID 和账号 ID 的 UI 展示值。

可配置保存但默认谨慎：

- 消息正文。
- 文件名和媒体 URL。
- 完整请求/响应 body。

指纹使用带本机随机密钥的 HMAC。普通 SHA-256 不是首选，因为字段空间可能可枚举。所有导出流程重新运行脱敏，而不是直接复制存储层对象。

## 5. 原始事实与派生语义分离

`http_exchanges`/`payloads` 保存观察到的事实；`protocol_events`、`message_traces` 和 `trace_spans` 保存当前解析器得出的语义。

必须满足：

- 删除或重建派生数据不会破坏原始 exchange。
- 每条协议事件记录 `parser_id` 和 `parser_version`。
- 未知字段保留在原始 payload。
- 关联结果带 `exact/probable/ambiguous/unlinked` 可信度。
- 重新解析历史 exchange 不修改网络事实字段。

## 6. 重放安全模型

账号状态机：

```text
LIVE → REPLAY_QUEUED → REPLAY_SANDBOX → REPLAY_DRAINING → LIVE
```

强制规则：

- 每账号同时最多一个重放。
- `REPLAY_SANDBOX` 和 `REPLAY_DRAINING` 中，所有可能产生副作用的请求走本地模拟器。
- 未识别端点 fail closed，并把 replay 标记为需要检查。
- `sendtyping`、`sendmessage`、`getuploadurl`、CDN 上传、`notifyStart/Stop` 均不得触达真实服务。
- 重放响应沿用 Bot 当前请求携带的 `get_updates_buf`，不返回历史游标。
- daemon 重启后，未完成 replay 进入失败/待恢复状态，不能自动向真实上游补发捕获到的请求。
- replay 超时必须有确定的恢复路径和审计记录。

## 7. 线程和所有权

- 主线程拥有监听 socket、账号路由和上游连接池。
- Storage Worker 独占 SQLite 连接与 migration 执行。
- CPU 密集媒体操作使用独立 Worker，不与 Storage Worker 混用。
- Worker 消息使用可序列化 DTO，不传递隐藏状态的闭包或类实例。
- 所有队列有长度和字节数上限，并暴露指标。

## 8. 前后端契约

- REST 和 SSE 事件定义位于 `packages/contracts`。
- 网络输入仍需运行时校验，TypeScript 类型不能替代验证。
- BigInt 在 JSON API 中编码为十进制字符串。
- SSE 发送摘要与实体 ID，不推送完整敏感 payload。
- Vue 通过 REST 获取权威状态，SSE 只触发增量刷新或 cache invalidation。

