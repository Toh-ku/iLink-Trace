# iLink Trace

iLink Trace 是微信 iLink / ClawBot 协议的本地可观测代理与调试沙箱。它位于 Bot 与 iLink 服务之间，记录脱敏 HTTP 交换、解析协议事件、实时展示消息链路，并能在不触达真实上游的情况下重放已记录的文本消息。

> 当前版本是可运行的 MVP。它适用于允许自定义 iLink API base URL 的客户端，不实施 HTTPS MITM，也不能自动接管写死官方地址的客户端。

## MVP 已实现

- Node.js 原生 HTTP + undici 数据面代理，默认监听 `127.0.0.1:8787`。
- Fastify REST + SSE 控制面，默认监听 `127.0.0.1:8788`。
- 受信上游校验、账号 token HMAC 指纹和二维码确认 `baseurl` 改写。
- 有界 request/response 捕获；转发完成后异步解析和写入 SQLite Worker。
- `get_qrcode_status`、`getupdates`、`getconfig`、`sendtyping`、`sendmessage`、`getuploadurl` 和生命周期通知解析。
- Vue 3 控制台：概览、实时事件、HTTP exchange 详情、重放运行、脱敏 JSON 导出和明暗主题。
- 账号级文本重放沙箱：当前游标保持不变，typing/send/notify 不访问真实上游，未知端点 fail closed。
- 默认不保存消息正文；Authorization、bot token、二维码信息和用户 ID 不以明文落库。

## 本地运行

要求 Node.js 24 和 pnpm 11。

```powershell
pnpm install
pnpm build
pnpm start
```

启动后终端会输出控制台 URL，例如：

```text
iLink Trace console: http://127.0.0.1:8788/?token=<generated-token>
```

在 Bot 或客户端中把 iLink API base URL 设置为：

```text
http://127.0.0.1:8787
```

打开 daemon 输出的控制台 URL 后即可查看流量。访问令牌只保存在当前浏览器 `sessionStorage`，刷新页面仍有效，关闭浏览器会话后清除。控制台默认跟随系统明暗偏好，手动选择会单独保存在浏览器 `localStorage` 中。

开发模式需要分别运行 daemon 与 Vite；根命令会并行启动二者：

```powershell
pnpm dev
```

Vite 开发地址为 `http://127.0.0.1:5173`，`/api` 会代理到本地控制面。

## 配置

daemon 读取启动工作目录中的 `.env` 文件，首次使用时复制示例文件：

```powershell
Copy-Item .env.example .env
pnpm start
```

`.env` 已被 Git 忽略；不要把真实凭据写入 `.env.example`。未创建 `.env` 时使用下表默认值。

| `.env` 配置项                         | 默认值                          | 说明                                     |
| ------------------------------------- | ------------------------------- | ---------------------------------------- |
| `ILINK_TRACE_PROXY_HOST`              | `127.0.0.1`                     | 数据面监听地址                           |
| `ILINK_TRACE_PROXY_PORT`              | `8787`                          | 数据面端口                               |
| `ILINK_TRACE_CONTROL_HOST`            | `127.0.0.1`                     | 控制面监听地址                           |
| `ILINK_TRACE_CONTROL_PORT`            | `8788`                          | 控制面端口                               |
| `ILINK_TRACE_PUBLIC_PROXY_ORIGIN`     | `http://<proxy-host>:<port>`    | 写回登录响应的本地代理地址               |
| `ILINK_TRACE_UPSTREAM`                | `https://ilinkai.weixin.qq.com` | 初始和未知账号使用的受信上游             |
| `ILINK_TRACE_ALLOWED_UPSTREAM_HOSTS`  | `weixin.qq.com`                 | 逗号分隔的上游域名后缀 allowlist         |
| `ILINK_TRACE_DATA_DIR`                | `.ilink-trace`                  | SQLite 和本机 HMAC 密钥目录              |
| `ILINK_TRACE_WEB_ROOT`                | 内置 Web 构建目录               | Vue 控制台静态文件目录                   |
| `ILINK_TRACE_CAPTURE_BODY_BYTES`      | `1048576`                       | 单向 body 最大捕获字节数；不限制转发大小 |
| `ILINK_TRACE_CAPTURE_MESSAGE_CONTENT` | `false`                         | 是否保存消息正文；文本重放需要先启用     |
| `ILINK_TRACE_RECORDER_QUEUE_SIZE`     | `500`                           | 异步记录队列最大 exchange 数             |
| `ILINK_TRACE_LOG_LEVEL`               | `info`                          | Pino 日志级别                            |

生产路径只接受 HTTPS、无 userinfo、端口 443 且命中 allowlist 的上游。测试中的本地 HTTP 上游只能通过代码级依赖注入启用，环境变量不能关闭此限制。

## 安全重放

1. 启动前设置 `ILINK_TRACE_CAPTURE_MESSAGE_CONTENT=true`。
2. 让目标文本消息经过代理并出现在“最新事件”中。
3. 点击该入站消息的“隔离重放”。
4. Bot 下一次 `getupdates` 会收到本地注入消息；随后 `getconfig`、typing、send 和 notify 均由沙箱处理。
5. 第一条 `sendmessage` 被捕获后，本次重放完成，不会发送给真实微信服务。

执行重放会生成新的消息 ID、序号、时间和临时 context token，降低 Bot 去重的概率。保真重放保留已安全存储的非敏感字段。两种模式都不会恢复或持久化原始 context token。

## API

控制 API 使用 `Authorization: Bearer <access-token>`。SSE 因浏览器 `EventSource` 限制使用本地 query token，控制服务不会记录请求日志。

主要端点：

- `GET /api/v1/health`
- `GET /api/v1/overview`
- `GET /api/v1/exchanges`
- `GET /api/v1/exchanges/:id`
- `GET /api/v1/protocol-events`
- `GET /api/v1/events`（SSE）
- `POST /api/v1/replays`
- `POST /api/v1/replays/:id/cancel`
- `GET /api/v1/replays`
- `GET /api/v1/export`

## 当前限制

- 官方客户端若把登录地址写死为 HTTPS 官方域名，仍需要 client adapter；本项目不会安装本地 CA 或劫持 DNS。
- Account Registry 当前保存在进程内。daemon 重启后区域上游映射需要重新从登录流程发现，或通过 `ILINK_TRACE_UPSTREAM` 指定初始地址。
- MVP 只支持文本重放；媒体上传在重放中明确拒绝。
- 消息正文默认关闭，因此默认记录可观测但不可直接重放。
- 只从 iLink 网络流量无法得知模型名称、token 消耗或 AI 内部耗时；界面不会把未观察区间伪装成 AI 耗时。
- `ret: 0` 只表示观察到的业务接受，不代表最终用户已经收到消息。

## 验证

```powershell
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test:unit
pnpm build
pnpm test:integration
```

集成测试只连接进程内的本地上游模拟器，不访问真实微信服务。

## 设计与贡献

- [技术设计](docs/technical-design.zh-CN.md)
- [Agent 入口规则](AGENTS.md)
- [实现计划](.agent/implementation-plan.md)
- [架构不变量](.agent/architecture-guardrails.md)
- [验证指南](.agent/verification.md)

提交代码前请阅读 `AGENTS.md`，并保持功能单元级提交，不把无关格式化或重构混入同一个提交。
