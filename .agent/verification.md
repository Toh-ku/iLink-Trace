# Verification Guide

本文件定义 Agent 在交付不同类型改动前应执行的最低验证。选择与风险相称的检查，不用无关的重型测试代替关键场景。

## 1. 通用检查

工程骨架建立后，所有代码改动至少执行：

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test:unit
pnpm build
```

影响代理、存储、协议关联或重放时追加：

```bash
pnpm test:integration
```

如果命令不存在，应先按 `AGENTS.md` 的根脚本契约补齐，而不是在 CI 中绕过。

## 2. 按改动类型验证

### Proxy / HTTP

- 方法、路径、query 和多值 header 保持正确。
- hop-by-hop headers 被移除。
- JSON 改写后 Content-Length 正确。
- 超过捕获上限后仍完整转发。
- gzip/identity 响应行为明确。
- 35 秒长轮询不被默认超时中止。
- 客户端断连会取消上游。
- 上游断流不会产生伪造成功响应。

### Account / Upstream Routing

- token 只以 HMAC 指纹持久化。
- 未知 token 得到明确、安全的错误。
- 非 HTTPS、userinfo、私网和恶意重定向被拒绝。
- Host、Forwarded 和 query 不能改变上游。
- 多账号并发不会串线。

### Protocol Parser

- 正常 fixture。
- 缺失可选字段。
- 字段类型错误。
- 新增未知字段。
- 非 JSON 或截断 body。
- `ret` 缺失、零值和非零值。
- parser 异常只产生诊断，不影响代理结果。

### Storage / Migration

- 空数据库从零迁移。
- 上一个已发布版本升级。
- migration 重复执行的失败/幂等行为明确。
- WAL、foreign_keys、busy_timeout 生效。
- Worker 退出、重启和队列满行为明确。
- 数据清理不会删除保留期内记录。

### Replay

- 状态机拒绝非法迁移。
- 同账号并发 replay 被拒绝或排队。
- `get_updates_buf` 保持当前值。
- sendmessage/sendtyping/upload/notify 不触达真实上游。
- 未知端点 fail closed。
- 完成、取消、超时和 daemon 重启都能安全恢复。
- 创建前检查账号在途 LIVE 请求；异步创建期间同账号只能占用一次。
- 完成/取消/超时写库失败时保持账号隔离；超时回调不能产生未处理 Promise rejection。

### Vue / Control API

- DTO 经过运行时 Schema 校验。
- SSE 事件不包含完整敏感 payload。
- `Last-Event-ID` 恢复行为。
- 大列表虚拟滚动。
- exact/probable/ambiguous/unlinked 在 UI 中可区分。
- HTTP 成功、业务接受和最终送达未知在 UI 中可区分。

## 3. 安全扫描

本地 simulator 场景及验收边界见 [本地可靠性验证](../docs/reliability.zh-CN.md)。35 秒长轮询必须使用真实时间；SQLite Worker 集成测试前先执行 `pnpm build`。代理取消检查必须包含下游已产生背压的断连场景。

提交前搜索常见敏感字段：

```bash
rg -n --hidden -g '!node_modules' -g '!*.lock' \
  "(Authorization: Bearer|bot_token[\"']?\\s*[:=]\\s*[\"'][^<*]|context_token[\"']?\\s*[:=]\\s*[\"'][^<*])"
```

命中 fixture 时确认值为明显占位符，例如 `<redacted>`、`test-token`，且不能来自真实流量。

## 4. 文档改动

- 检查相对链接和文件名。
- 示例不得包含真实 token、用户 ID、二维码或公网可访问测试服务。
- 版本事实附官方来源或标注为待验证。
- 技术设计、AGENTS 和当前实施阶段保持一致。

## 5. 交付报告

最终说明至少包含：

- 修改了什么。
- 运行了哪些命令，结果如何。
- 哪些验证未运行以及原因。
- 是否涉及数据格式、配置、迁移或安全边界。
- 仍然存在的已知限制。
