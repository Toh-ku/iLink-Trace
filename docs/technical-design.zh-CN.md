# iLink Trace 技术可行性与架构设计

> 状态：提案（Proposed）  
> 日期：2026-09-29  
> 技术方向：TypeScript / Node.js + Vue 3  
> 本文用途：作为项目立项、技术选型、MVP 边界与后续实现的共同基线。

## 1. 项目结论

iLink Trace 技术上可行，适合实现为一个运行在 Bot 与微信 iLink 服务之间的本地代理和协议沙箱。它负责记录 HTTP 交换、解析协议语义、关联消息链路、展示实时事件，并在受控环境中重放历史消息。

项目建议继续推进，但需要修正两个原始假设：

1. 反向代理不能拦截一个本来没有经过它的二维码登录请求，因此“自动劫持 `baseurl`”只能用于允许配置初始 API 地址的 Bot 或 SDK。
2. 安全重放不能只拦截 `getupdates` 和 `sendmessage`，必须隔离 `sendtyping`、媒体上传、生命周期通知等所有可能产生真实副作用的端点。

修正后的产品定位建议为：

> iLink Trace 是微信 iLink / ClawBot 协议的本地可观测代理与调试沙箱。对于支持自定义 iLink API 地址的 Bot，只需修改一处接入配置，无需修改消息处理业务逻辑，即可获得协议诊断、链路追踪、历史重放和测试导出能力。

整体可行性评估：

| 能力                | 可行性 | 说明                                               |
| ------------------- | -----: | -------------------------------------------------- |
| HTTP 请求/响应记录  |     高 | Node.js 原生 HTTP 和流 API 足够完成                |
| 长轮询观测          |     高 | 需要正确处理超时、取消和客户端断连                 |
| iLink 协议解析      |     高 | 公开协议资料和官方实现可作为依据                   |
| 消息链路关联        |   较高 | 需要组合 `context_token`、`run_id`、用户和时间窗口 |
| Vue Web 时间线      |     高 | 主要工作量在交互和数据组织                         |
| AI 内部调用观测     |     低 | 仅靠 iLink 流量无法看见模型调用内部信息            |
| 安全历史重放        |     中 | 可实现，但必须设计成协议沙箱                       |
| 任意 Bot 零适配接入 |   较低 | 取决于 Bot 是否允许配置初始 API 地址               |

## 2. 目标和非目标

### 2.1 MVP 目标

- 代理并记录 iLink Bot API 的请求和响应。
- 根据账号安全地选择真实上游地址。
- 解析二维码登录、消息轮询、配置、输入状态、消息发送和媒体元数据。
- 把一次入站消息及其后续调用关联为一条 trace。
- 通过 Vue Web UI 实时展示消息视图和时序视图。
- 支持文本消息的隔离重放，默认不触达真实微信服务。
- 支持脱敏 JSON 导出。
- 默认只在本机运行，不成为公网代理。

### 2.2 非目标

- 不实现 Bot 框架或 AI 回复逻辑。
- 不替代腾讯官方 SDK 或 OpenClaw channel。
- 不承诺仅凭 iLink 流量获得模型名称、token 消耗、首 token 延迟等 AI 指标。
- MVP 不保存媒体文件明文，只保存媒体元数据和加解密结果。
- MVP 不提供中心化多租户服务。
- 不通过 DNS 劫持或本地 CA 证书实施 HTTPS MITM。

## 3. 关键接入约束

### 3.1 为什么无法对所有 Bot 自动劫持

Trace 只有先收到 `get_qrcode_status` 响应，才能把其中的真实 `baseurl` 保存下来并改写成本地地址。如果 Bot 直接访问 `https://ilinkai.weixin.qq.com`，Trace 不在网络路径上，就无法看到或修改响应。

截至本文日期，腾讯官方 `openclaw-weixin` 登录实现仍将二维码请求和状态轮询指向固定地址 `https://ilinkai.weixin.qq.com`，即使函数签名中存在 `apiBaseUrl` 参数，当前登录路径也没有使用该参数。这意味着“扫码时自动改写 `baseurl`”不能直接覆盖官方客户端的所有版本。

因此项目提供三种接入模式：

#### 模式 A：Bootstrap Proxy，推荐

Bot 支持设置初始 iLink API 地址：

```text
Bot → http://127.0.0.1:8787 → real iLink
```

Trace 代理完整登录流程，在确认登录时记录真实 `baseurl`，再把响应中的 `baseurl` 改成本地代理地址。这是功能最完整的模式。

#### 模式 B：Existing Session Attach

Bot 已经登录，用户将本地账号配置中的 `baseUrl` 改为 Trace 地址，并通过 Trace CLI 登记原始上游地址。该模式不观察二维码登录过程，但能观察后续 API。

#### 模式 C：Client Adapter

针对官方 OpenClaw 或其他固定登录地址的客户端提供最薄适配层，让其支持 bootstrap URL。适配器只改变网络接入，不侵入 Bot 的业务处理逻辑。

项目文案不得声称“支持任意 Bot 的透明劫持”，应明确接入前提。

### 3.2 上游路由

登录确认响应可能返回区域性 `baseurl`，登录过程中也可能通过 `redirect_host` 切换轮询主机。Trace 必须在改写响应之前保存真实地址，并建立如下映射：

```text
bot token 指纹 → account_id → upstream base URL
```

后续请求从 `Authorization` 中临时读取 token，计算指纹后查找上游。原始 token 只存在于请求内存中，不写入数据库或普通日志。

上游 URL 必须经过验证：

- 只允许 HTTPS。
- 禁止 URL userinfo。
- 默认只允许经过配置或登录流程发现的微信域名。
- 禁止把请求 Host 直接当成上游，避免开放代理和 SSRF。
- 对 `redirect_host` 执行同样的验证。

## 4. 技术栈

### 4.1 推荐选型

| 层           | 选型                                  | 说明                                            |
| ------------ | ------------------------------------- | ----------------------------------------------- |
| 运行时       | Node.js 24 LTS                        | 当前生产稳定线，和官方 OpenClaw Node 生态一致   |
| 主语言       | TypeScript，ESM                       | 代理、协议、存储、API 统一使用 TS               |
| 包管理       | pnpm workspace                        | 管理 daemon、web 和共享包                       |
| 数据面代理   | `node:http` / `node:https` + `undici` | 保留对流、取消、超时和连接池的控制              |
| 控制面 API   | Fastify                               | REST、SSE、Schema 校验、静态资源服务            |
| Schema       | TypeBox 或 Zod，二选一                | API 输入校验和 TS 类型推导；项目内只保留一套    |
| 数据库       | SQLite + `better-sqlite3`             | 成熟、稳定；放入 Worker Thread 避免阻塞代理循环 |
| 数据迁移     | 版本化 SQL migrations                 | 保持透明，避免 ORM 隐藏 SQLite 行为             |
| 前端         | Vue 3 + TypeScript + Vite             | 组件化、开发体验和构建速度适合本地工具          |
| 前端路由     | Vue Router                            | 页面和详情路由                                  |
| 服务端状态   | `@tanstack/vue-query`                 | 请求缓存、分页和失效管理                        |
| 本地 UI 状态 | Pinia（按需）                         | 只存筛选器、布局、用户偏好等客户端状态          |
| 样式         | Tailwind CSS                          | 快速构建调试工具界面                            |
| 实时推送     | SSE                                   | MVP 只有服务端到浏览器的单向事件流              |
| 测试         | Vitest + Playwright                   | 单元、协议夹具、集成和浏览器端测试              |
| 日志         | Pino                                  | 结构化日志和内建脱敏配置                        |
| 构建         | tsup/esbuild + Vite                   | daemon 打包和 Vue 静态资源构建                  |

### 4.2 为什么选择 Node.js 24 LTS

Node.js 24 当前处于 LTS，而 Node.js 26 尚处于 Current。生产工具优先采用 LTS，避免把代理的稳定性绑定到短周期版本。

TypeScript/Node.js 对本项目有以下优势：

- 官方 `openclaw-weixin` 本身使用 TypeScript，协议类型和行为更容易交叉验证。
- 后端、协议模型、API DTO 和 Vue 前端可共享类型。
- Node 流模型足以处理 iLink JSON 长轮询。
- OpenClaw 生态开发者更容易阅读和贡献。
- npm 包和 Docker 镜像发布门槛较低。

需要接受的代价：

- 单个原生可执行文件不如 Go 自然。
- SQLite 原生扩展需要处理多平台预构建产物。
- CPU 密集型媒体加解密不能长期占用主事件循环。

因此首发分发方式定为 npm CLI 和 Docker，不把“单二进制”列为 MVP 硬指标。

### 4.3 为什么暂不直接使用 `node:sqlite`

Node 内置 `node:sqlite` 很有吸引力，可以减少原生第三方依赖，但截至本文日期，它在最新 Node 文档中的稳定性仍为 Release Candidate，并非完全稳定 API。

MVP 使用 `better-sqlite3`，但通过 `StorageAdapter` 隔离数据库实现。数据库操作运行在独立 Worker Thread 中，主代理线程只发送批量写入消息。待 `node:sqlite` 稳定后，可以增加内置实现并减少原生依赖。

不建议直接在代理事件循环里同步写 SQLite，即使单次写入很快，也可能给长轮询和并发请求造成尾延迟。

### 4.4 为什么 MVP 使用 SSE 而不是 WebSocket

实时数据方向主要是：

```text
Trace daemon → Vue UI
```

重放启动、取消、导出等操作继续使用 REST。SSE 提供浏览器原生重连、事件 ID 和普通 HTTP 调试能力，协议维护成本低于 WebSocket。如果未来需要高频双向消息或二进制传输，再增加 WebSocket。

## 5. 总体架构

```text
┌───────────────────┐
│     iLink Bot     │
└─────────┬─────────┘
          │ HTTP
          ▼
┌──────────────────────────────────────────────────┐
│                 Trace Daemon                     │
│                                                  │
│  ┌──────────────┐   ┌─────────────────────────┐ │
│  │ Proxy Server │──▶│ Account / Upstream      │ │
│  │ :8787        │   │ Resolver                │ │
│  └──────┬───────┘   └───────────┬─────────────┘ │
│         │                       │               │
│         │        ┌──────────────┴────────────┐  │
│         │        │                           │  │
│         ▼        ▼                           ▼  │
│  ┌───────────┐  ┌───────────────┐   ┌────────┐ │
│  │ Recorder  │  │ Replay Sandbox│   │ iLink  │ │
│  └─────┬─────┘  └───────┬───────┘   │ Upstream│ │
│        │                │            └────────┘ │
│        ▼                ▼                       │
│  ┌─────────────────────────────┐                │
│  │ Parser + Trace Correlator   │                │
│  └──────────────┬──────────────┘                │
│                 ▼                               │
│  ┌─────────────────────────────┐                │
│  │ Storage Worker / SQLite WAL │                │
│  └──────────────┬──────────────┘                │
│                 │                               │
│  ┌──────────────▼──────────────┐                │
│  │ Control API + SSE :8788     │                │
│  └──────────────┬──────────────┘                │
└─────────────────┼────────────────────────────────┘
                  ▼
         ┌─────────────────┐
         │ Vue Web Console │
         └─────────────────┘
```

数据面和控制面使用不同端口：

- `127.0.0.1:8787`：只处理 iLink 代理请求。
- `127.0.0.1:8788`：Web UI、REST API 和 SSE。

这种拆分可以避免 UI 中间件、请求体解析和静态资源处理影响代理行为，也便于分别配置安全策略。

## 6. 后端模块设计

### 6.1 Proxy Server

职责：

- 接收 Bot 的 iLink API 请求。
- 识别账号并选择真实上游。
- 清理 hop-by-hop headers。
- 保持方法、路径、查询参数和业务请求头。
- 绑定客户端断连与上游请求取消。
- 记录请求、响应、耗时和错误阶段。
- 在 bootstrap 登录模式中改写 `baseurl`。
- 在重放模式下把请求路由到本地沙箱。

不建议把核心代理完全交给通用反向代理插件。iLink Trace 需要同时完成响应改写、有限 body 捕获、账号路由和重放拦截，直接使用 Node 原生 HTTP 流和 `undici` 更容易控制行为。

核心端点的 JSON 一般较小，可以在配置上限内缓冲，以便解析和改写：

```text
默认 JSON 捕获上限：1 MiB
超过上限：继续透明转发，只保存截断标记、大小和哈希
媒体 body：默认不保存
```

代理必须区分以下时间点：

- `accepted_at`：本地收到请求。
- `upstream_started_at`：开始请求上游。
- `upstream_headers_at`：收到上游响应头。
- `completed_at`：响应完整结束。
- `client_aborted_at`：客户端提前断开。

长轮询不能使用普通短请求的统一超时。`getupdates` 和二维码状态轮询需要独立的 headers timeout，并把客户端取消、代理超时和上游超时分开记录。

### 6.2 Recorder

Recorder 位于旁路，不能阻塞转发主路径。

实现方式：

- 主线程把 exchange 摘要放入有界内存队列。
- body 在限制内使用 Buffer 保存，超限后停止复制但不中断转发。
- 按数量或时间批量发送给 Storage Worker。
- 队列压力过高时优先停止保存 body，保留请求摘要和丢弃计数。
- UI 明确展示“记录降级”，禁止静默丢数据。

### 6.3 Protocol Parser

解析器只接收已经完成的 HTTP exchange，不直接控制网络转发。每个端点实现独立 parser：

```ts
interface ProtocolParser {
  readonly id: string;
  supports(exchange: HttpExchange): boolean;
  parse(exchange: HttpExchange, context: ParseContext): ProtocolEvent[];
}
```

首批解析器：

- `get_bot_qrcode`
- `get_qrcode_status`
- `getupdates`
- `getconfig`
- `sendtyping`
- `sendmessage`
- `getuploadurl`
- `msg/notifystart`
- `msg/notifystop`
- CDN 上传/下载元数据

解析原则：

- 宽松读取未知字段，不因字段增加而失败。
- 原始 exchange 永远独立保存，解析结果可以重建。
- 不用 TypeScript 接口假定字段一定存在。
- Schema 校验失败产生诊断事件，而不是破坏代理转发。
- parser 输出带 `parser_id` 和 `parser_version`。
- 协议升级后允许离线 reparse 历史 exchange。

### 6.4 Trace Correlator

Correlator 把协议事件关联为消息 trace。建议关联优先级：

1. 同账号下完全一致的 `context_token`。
2. 完全一致的 `run_id`。
3. `client_id` 与消息 ID 的已知关系。
4. 同账号、同用户、限定时间窗口内的调用。
5. 无法可靠关联时保持为孤立事件。

每次关联都保存可信度：

```text
exact      精确 token/run_id 匹配
probable   用户和时间窗口匹配
ambiguous  存在多个候选
unlinked   无法关联
```

UI 不应把推断关联展示成确定事实。

一次典型 trace 包含：

```text
inbound message
  ├─ getconfig
  ├─ sendtyping(status=1)
  ├─ unobserved processing gap
  ├─ sendmessage
  └─ sendtyping(status=2)
```

在没有 SDK 或 AI API 代理时，中间间隔只能称为 `unobserved processing gap`，不能标记为 AI 调用耗时。

### 6.5 Account Registry

Account Registry 保存：

- `account_id`
- token 指纹
- 当前真实上游 URL
- 上游来源（登录发现、手工配置、导入）
- 首次和最后活动时间
- 当前运行模式

token 指纹使用本地随机密钥计算 HMAC，不保存明文 token。这样既能稳定识别账号，也避免数据库泄漏后直接暴露凭据。

### 6.6 Replay Sandbox

重放以账号为粒度使用状态机：

```text
LIVE
  → REPLAY_QUEUED
  → REPLAY_SANDBOX
  → REPLAY_DRAINING
  → LIVE
```

行为定义：

- `REPLAY_QUEUED`：等待账号下一次 `getupdates`。
- `REPLAY_SANDBOX`：返回历史消息，账号所有相关请求进入本地模拟器。
- `REPLAY_DRAINING`：等待当前回复、typing 结束或超时。
- 回到 `LIVE` 后才允许请求真实上游。

沙箱必须处理：

| 端点               | 重放行为                         |
| ------------------ | -------------------------------- |
| `getupdates`       | 注入历史消息，不推进真实上游游标 |
| `getconfig`        | 返回历史或合成的 typing ticket   |
| `sendtyping`       | 记录但不转发                     |
| `sendmessage`      | 捕获新回复，记录但不转发         |
| `getuploadurl`     | 返回本地模拟上传地址或明确拒绝   |
| CDN 上传           | 写入临时隔离区或只记录元数据     |
| `notifyStart/Stop` | 记录但不转发                     |

游标策略：重放响应返回 Bot 当前请求所携带的 `get_updates_buf`，不回写历史游标，从而避免下一次真实轮询发生倒退。

提供两种重放类型：

- 保真重放：消息字段不变，用于协议兼容验证。
- 执行重放：重写消息 ID、序列号和时间戳，降低被 Bot 去重逻辑忽略的概率。

任何重放开始前都要检查该账号是否已有未完成的长轮询或重放任务。MVP 同一账号同时只允许一个 replay run。

## 7. 存储设计

### 7.1 SQLite 设置

建议初始化设置：

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
```

所有写入在 Storage Worker 中串行批处理。控制面查询也通过 Worker 消息执行，避免跨线程共享数据库连接。

### 7.2 核心表

#### `accounts`

账号指纹、真实上游和活动状态。不保存原始 bot token。

#### `http_exchanges`

一次请求和响应作为一条完整记录，包含：

- method、path、query
- 脱敏后的 headers
- 请求/响应 payload 引用
- HTTP status
- 上游 origin
- 各阶段时间戳和 duration
- error stage / error code
- 是否截断
- 是否来自 replay

不建议把 request 和 response 拆成两个主表，否则查询、事务一致性和生命周期表达都会更复杂。

#### `payloads`

在大小限制内保存 request/response body：

- content type
- encoding
- byte length
- SHA-256
- captured bytes
- redaction state
- truncated flag

#### `protocol_events`

解析后的语义事件，包含 parser 版本和 JSON data。

#### `message_traces`

一条入站消息对应的逻辑 trace。

#### `trace_spans`

属于 trace 的请求、typing、发送、处理间隔等 span。

#### `replay_runs`

重放配置、生命周期、结果和失败原因。

#### `replay_interactions`

沙箱内每个模拟请求和响应，便于对比旧回复与新回复。

### 7.3 数据保留

- 默认保留 7 天，可配置。
- 定时清理按小批次执行，避免长事务。
- 媒体临时文件有独立、更短的保留期。
- 支持按账号、trace、时间范围删除。
- 导出默认再次执行脱敏，不直接复制数据库内容。

## 8. Control API 与实时事件

REST 使用 `/api/v1` 前缀。建议首批接口：

```text
GET    /api/v1/health
GET    /api/v1/accounts
GET    /api/v1/traces
GET    /api/v1/traces/:id
GET    /api/v1/exchanges/:id
POST   /api/v1/replays
GET    /api/v1/replays/:id
POST   /api/v1/replays/:id/cancel
POST   /api/v1/exports
GET    /api/v1/events              # SSE
```

SSE 事件只发送摘要和实体 ID，不发送完整敏感 payload：

```text
exchange.created
protocol-event.created
trace.created
trace.updated
replay.updated
recorder.degraded
```

浏览器收到事件后通过 REST 增量刷新。SSE 使用单调递增事件 ID，短暂断线后可以用 `Last-Event-ID` 恢复；如果历史事件已清理，服务端要求客户端执行完整刷新。

API Schema 是前后端共享契约。建议从服务端 Schema 生成 OpenAPI，再生成前端 client 类型，避免手工维护两套 DTO。

## 9. Vue 前端设计

### 9.1 页面

#### Overview

- 账号和连接状态
- 当前长轮询
- 最近错误
- 记录降级或数据库压力告警
- 重放运行状态

#### Messages

聊天式消息视图，适合快速理解入站消息与 Bot 回复。每条消息展示：

- 账号和发送者脱敏标识
- 消息类型与时间
- 回复状态
- 总耗时
- 关联可信度
- 是否为重放结果

#### Traces

按消息展示时序和耗时：

- 泳道：Bot、Trace、iLink、Replay Sandbox。
- 矩形宽度表示持续时间。
- 颜色表示成功、业务拒绝、网络失败、取消和未知。
- 点击 span 打开 exchange 详情。

MVP 使用 CSS Grid + SVG 绘制时序图，不引入 D3。统计面板后续可以使用专门图表库。

#### Exchange Detail

- 请求/响应头，默认脱敏。
- 原始 JSON 和格式化 JSON。
- 解析出的协议事件。
- HTTP 状态与业务 `ret/errcode` 分开展示。
- body 截断、解析失败和记录降级提示。

#### Replay

- 选择历史入站消息。
- 选择保真或执行重放。
- 明确显示“所有出站副作用将被阻断”。
- 展示排队、注入、处理中、完成或超时。
- 比较旧回复/新回复、旧耗时/新耗时。

#### Settings

- 监听地址和端口。
- 数据保留策略。
- payload 上限。
- 敏感字段记录策略。
- 上游 allowlist。
- 导出默认脱敏策略。

### 9.2 前端状态边界

- TanStack Vue Query 保存服务端实体和分页结果。
- SSE 只负责失效通知，不复制完整服务端状态。
- Pinia 只保存纯 UI 状态，例如筛选器、面板尺寸和主题。
- URL query 保存可分享的筛选条件。
- 大列表使用虚拟滚动，避免长时间运行后 DOM 规模持续增长。

## 10. 项目结构

```text
ilink-trace/
├── apps/
│   ├── daemon/
│   │   ├── src/
│   │   │   ├── proxy/
│   │   │   ├── control-api/
│   │   │   ├── recorder/
│   │   │   ├── replay/
│   │   │   ├── storage/
│   │   │   ├── security/
│   │   │   └── cli/
│   │   └── package.json
│   └── web/
│       ├── src/
│       │   ├── pages/
│       │   ├── components/
│       │   ├── features/
│       │   ├── api/
│       │   └── stores/
│       └── package.json
├── packages/
│   ├── protocol/
│   │   ├── src/types/
│   │   ├── src/parsers/
│   │   ├── src/correlator/
│   │   └── fixtures/
│   ├── contracts/
│   │   ├── src/api/
│   │   └── src/events/
│   ├── storage/
│   │   ├── src/
│   │   └── migrations/
│   └── testkit/
│       ├── upstream-simulator/
│       └── bot-simulator/
├── docs/
│   ├── technical-design.zh-CN.md
│   ├── protocol.md
│   ├── replay.md
│   ├── security.md
│   └── adr/
├── pnpm-workspace.yaml
├── package.json
└── tsconfig.base.json
```

依赖方向：

```text
contracts ← protocol ← daemon
contracts ← web
storage   ← daemon
testkit   ← daemon/protocol integration tests
```

`web` 不得直接依赖 daemon 内部模块，daemon 也不得依赖 Vue 代码。

## 11. 安全与隐私

安全能力必须进入 MVP，而不是放到后续版本。

### 11.1 默认策略

- 两个服务默认只监听 `127.0.0.1`。
- Control API 启动时生成随机访问令牌。
- Web 页面使用严格的 Origin 检查和 CSP。
- 禁止 Control API 的任意跨域访问。
- `Authorization`、bot token、二维码 token 永不落入普通日志。
- `context_token` 默认只存 HMAC 指纹；需要原值的诊断模式必须显式开启。
- 消息正文可配置为保存、脱敏保存或完全不保存。
- 上游仅允许 HTTPS 和受信任域名。
- 重放默认 fail closed：无法识别的端点不允许转发真实上游。

### 11.2 业务成功语义

不能把 HTTP 200 等同于消息已送达。UI 分别展示：

1. 网络请求是否成功。
2. HTTP 状态是否成功。
3. 响应是否能解析。
4. `ret` / `errcode` 是否表示接受。
5. 最终客户端是否收到——通常未知。

Trace 只能报告观察到的事实，不应把“上游接受”描述为“用户已收到”。

## 12. 测试策略

### 12.1 单元测试

- 每个 parser 使用脱敏协议 fixture。
- baseurl 和 redirect_host 验证。
- header 脱敏。
- token 指纹稳定性。
- trace 关联及可信度。
- replay 状态机和非法迁移。

### 12.2 代理集成测试

使用 `upstream-simulator` 启动假的 iLink 服务，覆盖：

- 正常 JSON 请求和响应。
- 35 秒长轮询。
- 客户端提前断开。
- 上游超时、断流、非 JSON 响应。
- gzip/identity 内容编码。
- `baseurl` 改写后 Content-Length 更新。
- 区域 redirect。
- 大 body 截断但仍完整转发。
- 数据库不可用时代理仍能工作。

### 12.3 重放验收测试

必须证明：

- 重放不会改变真实 `get_updates_buf`。
- `sendtyping` 不触达真实上游。
- `sendmessage` 不触达真实上游。
- 媒体上传不触达真实 CDN。
- 重放超时后账号能恢复 LIVE。
- daemon 崩溃重启后不会错误地继续半完成重放。

### 12.4 前端 E2E

使用 Playwright 覆盖：

- 实时 trace 出现。
- SSE 断线重连。
- exchange 详情脱敏。
- replay 创建、运行、完成和取消。
- 大量 trace 下的虚拟列表。

## 13. 构建和发布

### 13.1 开发

```text
pnpm dev
  ├─ daemon watch
  └─ Vue Vite dev server
```

### 13.2 生产构建

1. Vite 构建 Vue 静态资源。
2. tsup/esbuild 构建 daemon ESM。
3. 把 Web dist、SQL migrations 和许可证放入 npm 发布包。
4. daemon 通过 `import.meta.url` 定位静态资源。

### 13.3 首发分发

- npm CLI：`npx @ilink-trace/cli`。
- Docker 镜像：适用于服务器或长期运行。
- 源码运行：面向贡献者。

Node Single Executable Applications 目前仍未完全稳定，Bun 编译也会引入不同运行时兼容性，因此本地原生单文件可执行程序放到后续评估，不作为 MVP 阻塞项。

## 14. 实施里程碑

### P0：接入可行性验证，2–4 天

- 验证一个 TypeScript Bot 或测试客户端能把 API 指向 `127.0.0.1:8787`。
- 验证二维码登录、`baseurl` 和 `redirect_host` 路由。
- 验证一条文本消息的完整转发。
- 输出支持/不支持的客户端接入矩阵。

验收门槛：不能证明流量稳定经过代理，就不进入完整 UI 开发。

### M0：Capture Proxy，1–2 周

- Node/TS 代理。
- Account Registry。
- Storage Worker + SQLite。
- 请求列表和 exchange 详情 API。
- 基础脱敏和保留策略。

### M1：Protocol Trace，1–2 周

- 核心 parser。
- trace correlator。
- 错误分层和关联可信度。
- fixtures 和上游模拟器。

### M2：Vue Console，1–2 周

- Overview。
- Messages。
- Traces。
- Exchange Detail。
- SSE 实时刷新。

### M3：Replay Sandbox，2–4 周

- 账号级状态机。
- 文本消息保真/执行重放。
- `getconfig`、typing、send、notify 隔离。
- 新旧回复和耗时对比。

### M4：Export 与发布，1–2 周

- 版本化 JSON 导出格式。
- 测试用例模板。
- npm/Docker 发布。
- Windows、Linux、macOS CI。
- 安全文档和威胁模型。

单人全职完成可公开使用版本，合理预期为 6–10 周。只实现文本链路的演示原型约需 2–3 周。

## 15. 开放问题

以下问题必须在 P0 或 M0 中验证，而不是仅靠文档假设：

1. 目标客户端是否接受 `http://127.0.0.1` 作为 API base URL。
2. 官方 OpenClaw 后续是否会支持可配置二维码登录地址。
3. 同一账号是否可能并发发起多个 `getupdates`。
4. 不同客户端如何持久化和去重 `message_id`、`seq`、`client_id`。
5. `context_token` 的生命周期和跨消息复用边界。
6. 媒体上传 URL 是否始终是完整 URL，是否存在其他 CDN 域名。
7. `sendmessage ret: 0` 之外是否存在可用于确认最终投递的信号。
8. Node 原生 SQLite 稳定后，是否值得替换 `better-sqlite3`。

## 16. 已确认的技术决策

| 决策             | 结果                                     |
| ---------------- | ---------------------------------------- |
| 主要实现语言     | TypeScript / JavaScript                  |
| 服务端运行时     | Node.js 24 LTS                           |
| 前端             | Vue 3 + TypeScript + Vite                |
| 数据面           | Node 原生 HTTP + undici                  |
| 控制面           | Fastify REST + SSE                       |
| 本地存储         | SQLite，通过独立 Worker 访问             |
| 首发 SQLite 驱动 | better-sqlite3，保留适配接口             |
| 实时协议         | SSE，WebSocket 延后                      |
| 首发分发         | npm CLI + Docker                         |
| 重放安全模型     | 账号级协议沙箱，默认禁止真实副作用       |
| 自动接入承诺     | 仅适用于支持自定义 API base URL 的客户端 |

## 17. 参考资料

- [腾讯 openclaw-weixin 协议文档](https://github.com/Tencent/openclaw-weixin/blob/main/docs/protocol_zh_CN.md)
- [腾讯 openclaw-weixin 二维码登录实现](https://github.com/Tencent/openclaw-weixin/blob/main/src/auth/login-qr.ts)
- [腾讯 openclaw-weixin 仓库](https://github.com/Tencent/openclaw-weixin)
- [Node.js 发布状态](https://nodejs.org/en/about/previous-releases)
- [Node.js SQLite API](https://nodejs.org/api/sqlite.html)
- [Vue 发布策略](https://vuejs.org/about/releases)
