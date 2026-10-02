# 本地可靠性验证

测试只连接 `127.0.0.1`，使用合成凭据和消息，不访问真实微信或 CDN。先构建 SQLite Worker，再运行集成测试：

```powershell
pnpm build
pnpm test:integration
```

35 秒长轮询测试等待真实时间，不使用 fake timers，单项允许 45 秒；其他集成测试仍使用默认 15 秒超时。端口动态分配，测试结束时关闭 socket、清理模拟上游计时器和重放任务。

可单独运行可靠性场景：

```powershell
pnpm exec vitest run --config vitest.integration.config.ts apps/daemon/src/proxy-reliability.integration.test.ts apps/daemon/src/replay-reliability.integration.test.ts packages/storage/src/trace.integration.test.ts
```

可复用的 [本地上游/内存 repository](../apps/daemon/src/testing/proxy-harness.ts) 暂在 daemon 测试目录，尚未抽取独立 `packages/testkit` 包。本地 HTTP 上游只通过代码级依赖注入启用，生产 HTTPS、端口和 allowlist 策略保持启用。

## 自动验证覆盖

| 范围           | 已覆盖场景                                                                                                                  |
| -------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 长轮询与取消   | 真实 35 秒完整响应；断连关闭上游；真实下游背压期间取消仍完成记录                                                            |
| HTTP 失败      | headers 超时返回 502；上游响应体断流使客户端读取失败，记录网络错误                                                          |
| HTTP 透明性    | 方法、路径、query、完整请求正文、多值响应头；双向删除固定及 Connection 指定的逐跳头                                         |
| 捕获边界       | 超限请求/响应仍完整转发，记录原始字节数和截断标记                                                                           |
| 内容与解析     | identity/gzip 原始响应字节和状态保持不变；非 JSON 和 parser 异常不改变转发                                                  |
| Bootstrap      | baseurl 改写与 Content-Length 更新；区域账号路由；redirect_host 用于下一次登录轮询；记录不含测试登录凭据                    |
| 上游路由       | Host/Forwarded/query 不能选择上游；并发账号不串线；拒绝非 HTTPS、userinfo、私网、非允许端口和伪造域名                       |
| 观测故障       | 写库失败产生记录降级；写库停滞和队列满不阻止 HTTP 转发                                                                      |
| 重放网络隔离   | execution/fidelity 保持当前游标；queued/sandbox/draining 的 config、typing、send、notify 和上传地址请求不触达模拟的真实上游 |
| 重放拒绝路径   | CDN 上传和未知端点 fail closed；失败账号保持隔离；非法 JSON/超限请求不转发；其他账号仍 LIVE                                 |
| 重放并发与恢复 | 拒绝在途 LIVE 请求；创建前占用账号，拒绝同账号第二次创建；创建失败可重试；完成、取消、超时后恢复 LIVE                       |
| 重放存储故障   | 终态写库失败保持隔离；超时失败无未处理 Promise rejection；存储恢复后显式取消                                                |
| SQLite 重启    | 真实 Worker 重新打开数据库，将 queued/sandbox/draining 标为失败，保留终态和捕获回复；重复启动不重新执行交互                 |
| 文本链路       | 真实代理/SQLite Worker/控制 API 覆盖 getupdates → getconfig → sendtyping → sendmessage，Trace 可查询且凭据脱敏              |

证据：[代理可靠性测试](../apps/daemon/src/proxy-reliability.integration.test.ts)、[重放网络隔离测试](../apps/daemon/src/replay-reliability.integration.test.ts)、[完整链路测试](../apps/daemon/src/proxy.integration.test.ts)、[SQLite 恢复测试](../packages/storage/src/trace.integration.test.ts)。

## 验收边界

2026-10-02 本地验证环境为 Windows、Node.js 24。CI 已配置 Linux/Windows/macOS 集成矩阵，本地通过不代表此次修改已通过远端三平台 CI。

本次新增 33 个集成场景。`pnpm format:check`、`pnpm lint`、`pnpm typecheck`、`pnpm build` 均通过；`pnpm test:unit` 的 25 个测试和 `pnpm test:integration` 的 40 个测试全部通过。真实 35 秒长轮询包含在全量集成测试中。修改文件的敏感字段检查只命中合成测试值，`git diff --check` 通过。

- 真实 Bot/SDK 接入兼容性和客户端版本矩阵尚未验证，P0 出口条件仍未全部满足。
- gzip 测试证明原始字节透明转发；bootstrap 地址改写仍要求捕获范围内的未压缩 JSON。
- 域名/IP 字符串校验不等于 DNS 重绑定验收，DNS 解析前后校验仍需完善。
- 队列满验证覆盖条数上限和不阻塞转发；字节预算、渐进舍弃正文、持续负载和内存/尾延迟测量待补。
- SQLite 重启验证覆盖持久化恢复，尚未执行强制终止整个 daemon 进程的崩溃注入。
- 本次不包含浏览器 E2E、SSE 慢客户端、保留期清理或长期磁盘增长验证。

## 行为修复

双向转发现在删除 Connection 指定的逐跳头。等待下游 drain 时绑定取消信号，避免客户端断连后永久等待。

重放在异步创建写库前占用账号，拒绝账号已有在途 LIVE 请求。终态提交期间拒绝新的沙箱交互，取消超时计时器，避免覆盖终态。完成、取消和超时先取得存储确认再恢复 LIVE；写库失败保留隔离，存储恢复后可显式取消。REST/SSE 契约、环境配置和数据库格式没有变化。
