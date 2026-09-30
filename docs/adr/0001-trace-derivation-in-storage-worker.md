# 消息 Trace 在 Storage Worker 中派生

日期：2026-09-30

完整消息 Trace 需要在历史入站消息中查找候选，更新关联身份、span 与摘要，并保证它们与新 exchange / protocol event 同时提交。为避免重启丢失关联状态或在主线程缓存所有历史消息，派生过程在 Storage Worker 的事务中完成。

关联、错误分层和摘要计算是 `packages/protocol` 公开导出的纯函数；Worker 传入已脱敏协议事件与候选记录。存储包因此新增对 protocol 公共入口的依赖。这是对原设计依赖图的明确扩展：`contracts ← protocol ← storage ← daemon`，daemon 仍直接使用 protocol。protocol 不依赖 SQLite、Fastify、Vue 或 daemon；storage 不反向依赖 daemon；前端只依赖 contracts。

新增 migration 002 建立 `message_traces` / `trace_spans` 和关联索引，在同一事务中分批回填历史事件并登记版本。已存在的原始 exchange 和首版建表 SQL 保持不变。关联候选限制在同账号、同 live/replay 来源、且入站时间不晚于当前调用的记录；用户推断额外限制在 5 分钟内。多个候选保持歧义，并持久化候选 ID 供 UI 检查。

转发路径不等待这些操作。Recorder 在旁路调用 Worker，收到事务提交结果后才发布只含 Trace ID 的 SSE 通知。数据库不可用时仍沿用现有记录降级行为。

已知代价：首次回填与单条长 Trace 的摘要重算占用 Worker 时间，可能造成记录队列压力；这不改变代理的网络结果。后续可在保持这些表和 API 语义的前提下增量计算摘要。消息正文仍遵守捕获策略，context 和用户 ID 仅使用 HMAC 指纹。
