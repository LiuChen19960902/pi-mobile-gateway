# pi-mobile-gateway — WebSocket 协议参考

移动端通过一条经过设备鉴权的 WebSocket 连接使用 pi。本文档描述当前实现（协议版本 `1`，阶段 1 连接管理 + 阶段 2 业务帧）。

- **数据面端点**：`ws://<电脑局域网 IP>:3082/ws/mobile`（私网判定含 RFC1918、Tailscale 等 mesh VPN 的 100.64.0.0/10 与 IPv6 ULA/链路本地；公网必须 `wss://`，由 TLS 反向代理提供）。默认绑定 `0.0.0.0`，`--bind <IP>` 可收紧到单网卡（如只绑 mesh VPN 地址，共享局域网下不暴露端口）
- **帧格式**：全部为 JSON 文本帧（UTF-8）
- **连接即推送**：鉴权通过后服务端立刻发送 `hello`（含 `capabilities` 特性通告）

---

## 1. 通用约定

### 客户端 → 服务端（请求帧）

```json
{ "type": "<帧类型>", ...参数 }
```

### 服务端 → 客户端（响应/推送帧）

```json
{ "kind": "<类型>", ...数据 }
```

### 统一错误帧

```json
{ "kind": "error", "code": "bad-request", "message": "...", "requestType": "<来源请求 type>", "sessionId": "…（可选）" }
```

`code`：`bad-request` / `unknown-command` / `session-not-found` / `prompt-rejected` / `internal` / `session-restart-busy` / `attachment-not-found` / `attachment-too-large` / `attachment-invalid`。

补充安全错误分类：`directory-permission-denied` / `directory-not-found` / `directory-not-directory` / `directory-name-invalid` / `directory-name-conflict` / `filesystem-read-only` / `storage-full` / `history-cursor-invalid` / `provider-not-found` / `provider-config-read-failed` / `provider-config-write-failed`。文案为固定短句，不含原始OS异常、目标路径、游标或凭据；未知故障仍用`internal`，客户端不能据此推断权限。旧客户端仍可按通用请求拒绝处理，旧网关的`bad-request/internal`不能被新客户端猜成细分类别。

---

## 1.5 能力通告（hello.capabilities）

`hello` 帧携带 `capabilities` 数组，客户端据此做特性探测，不猜版本：

| capabilities | 含义 |
| --- | --- |
| `["ping"]` | 仅阶段 1（网关未接会话运行时） |
| `["ping","sessions","subscribe","unsubscribe","message","abort","history","state"]` | 阶段 2 全量业务帧 |
| `["…","directories","directory-create","workspace-create"]` | 阶段 3b：工作区选择器（宿主机目录服务） |
| `["…","models","set-model"]` | 模型目录与会话级模型切换（pi `getAvailable` / `setModel`） |
| `["…","providers","provider-put","provider-delete"]` | 模型 provider 管理（读写 pi `~/.pi/agent/models.json`） |
| `["…","provider-test","provider-models"]` | 上游连通性测试 / 拉取上游模型清单（网关会向用户填写的 `baseUrl` 发起出站请求） |
| `["…","name","compact","restart-session"]` | 会话改名 / 手动压缩 / 重建会话（重载配置） |
| `["…","commands"]` | 自定义命令清单（三源：扩展/模板/skill；执行复用 `message` 原文透传） |
| `["…","input-resources","input-completions"]` | Skills/Prompt 候选与宿主 @ 路径补全；按查询 ID 关联并取消旧搜索 |
| `["…","tree","switch-branch"]` | 会话分支树与分支切换 |
| `["…","entry-copy","label-put"]` | 树动作：整条 entry 可复制全文（Pi Ctrl+X）/ 标签写（Pi Shift+L）；同时宣告特性名 `tree-actions-v1` |
| `["…","attachment"]` | 历史图片按需取回（按 `sessionId+entryId+imageIndex`，单图 4 MiB） |

上表按阶段累积描述，**数组顺序不属于契约**：客户端只做成员检测（`kind in capabilities`）。

---

## 2. 设备配对与鉴权

### 凭据传递（升级请求）

| 方式 | 内容 |
| --- | --- |
| 首次配对（推荐） | 子协议 `pi-mobile-v1, pi-pair.<一次性配对码>` + 请求头 `X-Pi-Device-ID: <安装级 UUID>` |
| 首次配对（兼容） | query `?pairingCode=<code>`（子协议不进常见 URL access log，故优先） |
| 已配对（推荐） | 请求头 `Authorization: Bearer <设备 token>` |
| 已配对（兼容） | 子协议 `pi-mobile-v1, pi-auth.<设备 token>` |

硬性规则：

- 长期 token **禁止**出现在 URL query；
- 256-bit 秘密 = 43 字符无 padding Base64URL（`[A-Za-z0-9_-]{43}`）；
- `X-Pi-Device-ID` 是客户端持久保存的安装级 UUID（8–128 字符，`[A-Za-z0-9._:-]`），仅用于重新配对时复用设备行，不能替代凭据；缺少该头的配对请求返回 `400`。

### 配对载荷（二维码 / 手动复制文本）

二维码与手动复制内容是**同一个**严格无 padding Base64URL 字符串，解码后为：

```json
{
  "version": 1,
  "publicUrl": "ws://<宿主IP>:3082/ws/mobile",
  "pairingCode": "<一次性 256-bit 配对码>",
  "expiresAt": 1788234336499
}
```

- 配对码 TTL 30 分钟，**仅可使用一次**，领取即消费（即使后续升级失败）；
- 只存内存：网关重启后所有未用配对码作废（已配对设备不受影响）；
- 客户端必须严格 Base64URL 解码（拒绝 `=` padding、标准 Base64、裸 JSON、空白）。

### 升级拒绝（HTTP 状态码，无 WebSocket 帧）

| 状态 | 含义 | 客户端动作 |
| --- | --- | --- |
| `401` | 凭据缺失/无效/过期/已用 | 清除旧 token，进入重新配对流程 |
| `400` | 配对缺少 `X-Pi-Device-ID`，或请求行/URL 非法 | 升级客户端 / 检查请求 |
| `403` | 来源地址不是回环/私网（私网含 RFC1918、100.64.0.0/10 mesh VPN、IPv6 ULA/链路本地）。来源检查基于 TCP 对端地址：端口转发/DNAT（如 Docker `-p`）与反向代理下的公网来访会呈现为私网/代理地址而被放行，因此这不是「公网不可达」的保证——勿直接发布到公网，公网走 `wss://` 反向代理 | 检查网络路径；公网需走 `wss://` 反向代理 |
| `404` | 路径不是 `/ws/mobile` | 检查地址 |

### 配对成功的初始帧序列

```json
{ "kind": "paired", "token": "<长期设备 token>",
  "device": { "id": "...", "name": "...", "createdAt": ..., "lastSeenAt": null, "online": false, "connections": 0 } }
{ "kind": "hello", "protocol": 1, "authenticated": true,
  "device": { "id": "...", "name": "..." }, "port": 3082, "clients": 1,
  "capabilities": ["ping", "sessions", "subscribe", "unsubscribe", "message", "abort", "history", "state", "models", "set-model", "directories", "directory-create", "workspace-create", "providers", "provider-put", "provider-delete", "provider-test", "provider-models", "restart-session", "name", "compact", "commands", "tree", "tree-view-v1", "switch-branch", "attachment"] }
```

- `paired` 只发送一次；客户端必须立即把 `token` 存入系统安全存储（iOS Keychain / Android Keystore），服务端不再下发；
- 服务端落盘的只有 token 的 SHA-256 摘要；
- 同一 `X-Pi-Device-ID` 重新配对 = token 轮换（旧 token 立即失效），设备行不重复；
- **吊销**（管理面 revoke）会立即关闭该设备的全部在线连接，close code `4003`，reason `device revoked`。

---

## 3. 连接管理（已实现）

| type | 参数 | 说明 |
| --- | --- | --- |
| `ping` | — | 心跳；回复 `pong` |

```json
{"type":"ping"}
→ {"kind":"pong","at":1786937352316}
```

任何未知 `type`、非法 JSON、二进制帧 → `{"kind":"error","code":"unknown-command" | "bad-request"}`，连接保持不断开。

**帧大小限制**：任何帧（含文本帧）超过 18 MiB 时，连接直接以 close code `1009` 关闭（不发送 error 帧）。上限与客户端图片总预算（4 张压图合计 base64 ≤ 16 MiB）对齐，避免大图触发硬断连。

---

## 4. 业务帧（阶段 2，已实现）

词汇表是 **pi 原生的**：会话即 pi 会话（`~/.pi/agent/sessions/` 下的 JSONL 文件），事件即 pi `AgentSessionEvent` 的 JSON 投影，历史按 pi 的条目树分页。保留 dsh 的帧骨架（`type` 请求 / `kind` 应答 / 统一 error 帧），不兼容 dsh 网关的载荷。

### 4.1 `sessions` — 会话列表

```json
{"type":"sessions"}
→ {"kind":"sessions","items":[{
     "id":"<uuid>","path":"<jsonl 绝对路径>","cwd":"/…","name":null,
     "created":"…ISO…","modified":"…ISO…","messageCount":3,
     "firstMessage":"…","running":false}]}
```

- 按 `modified` 倒序（pi `SessionManager.listAll()` 原序）；
- `running: true` 表示该会话此刻在网关内有活动句柄且正在流式/压缩；
- 列表走 15 秒 TTL 的索引缓存：**网关内**新建的会话立即出现；桌面 pi 直接新建的会话最长延迟 15 秒可见（期间 `message sessionId` 同样解析不到）。

### 4.2 `message` — 发送消息（新建或续聊）

```json
{"type":"message","sessionId":"<已有会话>","text":"…","mode":"prompt|steer|followUp"}
{"type":"message","cwd":"/绝对路径","text":"…"}            // 新建会话
→ {"kind":"sent","sessionId":"<uuid>","mode":"prompt",
   "disposition":"started|queued|handled","isStreaming":true,"isCompacting":false,
   "queuedMessages":{"steering":[],"followUp":[]}}
```

- `sessionId` 与 `cwd` **二选一**：`sessionId` 续已有会话；`cwd`（绝对路径、必须存在的目录）新建会话；
- **`text` 与 `images` 不能全空**：纯图消息合法（`text` 空字符串 + `images` 非空）；两者全空 → `bad-request`（`message requires non-empty text or at least one image`）；
- **纯图消息会被网关注入单个空格占位**：pi 的 `prompt(text, {images})` 会**无条件**生成 `{type:"text", text}` 块（`agent-session.js`），空 text 会被 OpenAI 兼容上游拒（实测报 `400 messages 参数非法`）。因此网关在「text 全空白 + 携带图片」时改传 `" "`。可见后果：该消息在 pi 会话、`event` 帧与 `history` 回放中的 `text` 是 `" "` 而非 `""`，客户端应按**空白**（`isBlank`）而非 `isNotEmpty` 判定“无正文”。另有回退：会话列表的 `firstMessage` 对空白值回退为 `(no messages)`；
- `mode`（可选，默认 `"prompt"`）：`steer`/`followUp` 在会话正在流式时排队（pi 的 `streamingBehavior`）；不带 `mode` 且会话正在流式 → 错误帧（pi 语义，不猜默认）；
- 应答在**受理时**返回（pi preflight 通过即回 `sent`），不等运行结束——之后的一切通过 `event` 帧流式推送；受理后的失败（重试耗尽、provider 报错）也走事件流，不补发 error 帧；
- `prompt-disposition-v1` 能力表示 `sent` 携带 SDK 的 `disposition` 和受理后的会话快照。`started` 为普通运行、`queued` 为忙时排队、`handled` 为该次输入已被处理器消费；后者不表示整个会话空闲，也不能生成假的 `agent_settled`。客户端分开维护待回执输入与实际运行，按快照及后续事件收尾。旧网关缺少能力时保留旧行为；旧客户端可忽略新增字段。
- 同步校验/预检失败（无模型、流式中无 mode、扩展命令被拒等）→ `prompt-rejected` 错误帧；
- 发送方连接**自动订阅**该会话的事件流（先订阅后 prompt，不漏首帧）；
- **`images`（可选）：图片附件**，pi `ImageContent` 直传：`[{"type":"image","data":"<base64>","mimeType":"image/jpeg"}, …]`；校验：数组 ≤ 4 项（与 18 MiB 帧上限的 4 张预算对齐）、每项 `type` 必须为 `image`、`data` 非空、`mimeType` 必须 `image/*`，否则 `bad-request`；空数组等同不带；帧内多余字段一律丢弃，不进入 pi 请求。附件随消息进入 pi 会话记录，后续 history 亦还原它们；
- **`model`（可选）：模型预选** `{"provider":"…","modelId":"…","thinkingLevel":"…"}`（thinkingLevel 可省）：在首轮 prompt 前 `setModel` 应用，保证"先选模型再发第一条"的顺序生效（否则 pi 会用默认模型跑首轮）；非法结构或模型不存在 → `bad-request`（`message model must be …` / 模型错误消息）；
- **新会话初始模型与 pi CLI 同源**：settings 的 `enabledModels` 范围内解析，settings 的 `defaultProvider`/`defaultModel` 在范围内则优先它、否则用范围第一项（pattern 的 `:level` 档位随初始模型生效）；范围未配置时才落到 pi 的内置兜底（可能命中范围外模型）。scope 解析失败（如模型目录读取异常）不降级、拒绝本次创建——与 CLI 原生 fail loud 一致（CLI 带同款 15s 超时）。已有会话按会话记录恢复模型；

### 4.3 `subscribe` / `unsubscribe` — 事件流订阅

```json
{"type":"subscribe","sessionId":"<uuid>"}    → {"kind":"subscribed","sessionId":"…"}
{"type":"unsubscribe","sessionId":"<uuid>"}  → {"kind":"unsubscribed","sessionId":"…"}
```

- `subscribe` 会按需把会话加载进网关内存（幂等；已加载则复用）；
- 订阅按连接隔离：断线自动退订；多设备可同时订阅同一会话，收到的 `seq` 一致；
- `unsubscribe` 幂等（未订阅也返回 `unsubscribed`）。

### 4.4 `event` — 会话事件推送（服务端主动）

```json
{"kind":"event","sessionId":"<uuid>","seq":42,"time":1786937352.123,"event":{…pi 事件…}}
```

（`message_end` 帧在此基础上额外带帧顶层可选 `entryId`，契约见 §4.5。）

- `seq`：**网关进程内**按会话单调递增（从 1 开始，只发给过滤后真正下发的帧，无空洞）；跨网关重启不连续，客户端不得用它做跨重启的游标；
- `time`：Unix 秒（浮点）；
- `event` 为 pi 事件 JSON，投影规则见 §4.5；
- **单帧体积上限 1 MiB**（出站 event 帧自身预算）：超限的载荷先做降损（图片 base64 换成元数据占位、超长文本截断），仍超限则整个 `event` 替换为 `{"type":"event_omitted","originalType":"…","bytes":…,"reason":"…"}`——`seq` 照常递增，客户端在稳定后用 `history` 对账即可。
- **背压**：服务端出站缓冲（`bufferedAmount` + 待发帧）超过 8 MiB 即断开该连接（不降级单帧），客户端重连走 catch-up 语义补回；弱网/挂起客户端不会把网关堆到 OOM。

### 4.5 事件词汇表（pi 原生 + 带宽裁剪）

直接映射 pi 的事件类型（与 pi 自家 RPC stdout 协议同形）：
`agent_start`、`agent_end`、`agent_settled`、`message_start`、`message_update`、`message_end`、`tool_execution_start`、`tool_execution_update`、`tool_execution_end`、`queue_update`、`compaction_start`、`compaction_end`、`auto_retry_start/end`、`summarization_retry_*`、`bash_execution_update`、`entry_appended`、`session_info_changed`、`thinking_level_changed`、`extension_error`…

SDK 1.3.0 的 `agent_settled` 带布尔字段 `aborted`，网关随原生事件透传；运行终态仍由该事件及权威状态确认。

带宽投影（两处，均为 pi-web 同款裁剪）：

| 事件 | 裁剪 |
| --- | --- |
| `message_update` | 去掉累积快照 `assistantMessageEvent.partial`；`toolcall_start`/`toolcall_delta` 提升 `id`/`toolName` 到外层（pi `toJsonEvent` 语义）；`usage` 取自快照 `message.usage`（pi 自家投影同款，pi 核心不提供顶层 usage） |
| `agent_end` | 去掉 `messages`（每条消息已经由 `message_end` 权威送达），保留 `willRetry` |
| `turn_start` / `turn_end` | 不下发（回合边界由消息序列隐式表达） |

客户端组装规则（与 pi RPC 协议一致）：以 `message_start` 起泡、按 `contentIndex` 拼增量、`message_end.message` 为准；工具调用用 `toolCallId` 关联 start/update/end。

#### 实时身份：`message_end` 帧顶层的可选 `entryId`

pi 把一条消息（`user`/`assistant`/`toolResult` 角色）持久化到 `SessionManager` 内存会话时，会产生一个带 `id` 的条目。网关在下发该消息的 `message_end` 帧时，会在**帧顶层**盖一个**可选** `entryId` 字段，把这条实时消息和 pi 会话条目对上：

```json
{"kind":"event","sessionId":"…","seq":43,"time":…,"entryId":"e12",
 "event":{"type":"message_end","message":{…}}}
```

- **同源**：`entryId` 是 pi `SessionManager` 的条目 id（与 `history.entryIds`、`tree` 节点 id 同一 id 空间）；该 id 随条目持久化到 pi 内存会话，**不保证立刻落盘**（写文件时机由 pi 自己控制）；拿它与 `history.entryIds`/`tree` 对上是同一条目的确定性证据；
- **精确匹配，绝不推断**：`entryId` 由网关在事件出队时用 pi 公开入口 `SessionManager.getEntries()` 对事件携带的**原 message 对象引用**做身份匹配（`appendMessage` 原样保留该引用）得出；网关不做内容指纹、时间戳、角色推断或随机编造；
- **缺失语义**：匹配失败（pi 尚未/不再 append、`custom` 类型消息走独立的持久化入口、`getEntries` 读取异常等）时 `entryId` 整个缺席，帧本体照发不丢；客户端必须把缺席当“身份未知”处理，**禁止**在无 `entryId` 时用 `role`+内容或 toolCallId 把实时帧与历史条目配对——同一回合内可能出现多条同文消息（重试、中间快照、用户二次粘贴），指纹对不上就是删错条目；
- **一条消息多个事件**：同一条目可能先后发出多个实时事件。客户端如需把身份归并到“同一消息”，应以 **`sessionId` + `entryId` + 归一化 `type`/`toolCallId`** 为键；无 `entryId` 的事件不参与身份归并。

嵌套工具沿用公开执行事件的 `parentToolCallId`；`tool_execution_update` 也保留该字段。嵌套结果可能只有 `tool_execution_end`、没有独立持久化的 `toolResult` 消息，客户端必须据调用ID收尾；普通顶层工具仍以 `toolResult` 消息作为最终持久化结果，不重复显示两次。

可见 `message_end(role=custom)` 与 `entry_appended(type=custom_message)` 使用通用文本消息，不运行插件renderer；仅 `display=true` 显示，`custom` 内部记录不显示。网关在同一SDK追加批次内按事件/条目顺序绑定custom消息的 `entryId`，只在一一对应可证明时绑定；数量不符时省略身份，不按正文、时间或customType猜测。

### 4.6 `history` — 历史分页（条目游标）

```json
{"type":"history","sessionId":"<uuid>","beforeEntryId":"<可选游标>","limit":100,"resetLeaf":true}
→ {"kind":"history","sessionId":"…",
   "messages":[…渲染后的消息…],"entryIds":["e3","e4"],
   "hasMore":true,"oldestEntryId":"e3","latestEntryId":"e9","bytes":123456,
   "isStreaming":false,"isCompacting":false,
   "model":{"provider":"…","modelId":"…"}|null,"thinkingLevel":"medium",
   "queuedMessages":{"steering":[],"followUp":[]},
   "contextUsage":{"percent":42,"contextWindow":100000,"tokens":42000}|null}
```

- 内容 = 会话**活动分支**（从当前叶子向根回溯）的最新一页：通常来自当前会话文件，页内条目全部上送（compaction 条目渲染为标记行，不做模型上下文裁剪）；两个可证明的未落盘窗口由活动句柄的 live `SessionManager` 补入尚未落盘的条目，**两窗口共用同一前缀防护——文件视图必须是 live 条目的前缀（文件不存在/为空时平凡成立），前缀不成立（文件被外部重写/重排）时 live 视为陈旧不并入，避免已删除条目复活**：① Pi 首个 assistant 出现前会延迟创建/刷新新会话文件（不要求流式中）；② 旧会话 run 进行中（`isStreaming` 作为 in-flight 证据）——pi 先 emit 事件后 `appendMessage` 落盘，手机强退重开的 history 若只读文件会把刚发出的 user 判成不存在。外部删除文件尾部的复活风险与 pi 自身在该病态场景的数据不一致同源，属可接受残余；
- **游标分页**：`beforeEntryId` 互斥（不含该条）；首页不传。`hasMore` + `oldestEntryId` 指向更旧一页；游标不存在或不在活动分支上（含已放弃分支）→ `history-cursor-invalid` 错误（客户端应重取首页）；
- **`limit` 是“原始 entries 预算”，不是消息条数**：活跃链上存在不渲染为消息的元数据条目（`model_change`、`thinking_level_change`、空 `summary` 的 `branch_summary`、`custom` 内部数据 等），它们消耗预算但不进 `messages`，因此 `messages.length` 可以小于 `limit`。**仅当整页预算全被这类条目占满、转换后一条消息都没有时**，网关会沿该页最旧条目继续向前切（游标每轮严格变旧），直到出现可展示消息或走到真正的链头——避免旧行为返回“空页 + `hasMore:false`”把更早的消息永久挡住。**有可展示消息的页不会被跳过**，逐页仍按 `limit` 条原始 entries 前进。请求字段与响应结构均不变，无新增字段；
  - 边界：`display:false` 的 `custom_message` 在网关侧仍算“有消息”（原样上送，由客户端跳过渲染），这类页不触发向前补切；
- `messages` 与 `entryIds` 平行对齐（`entryIds[i]` 是 `messages[i]` 背后的条目 id，fork/定位用）；
- **`resetLeaf:true`（仅全新加载，翻页绝不能带）**：重连 catch-up 用（pi TUI"重开会话回文件尾"语义）——释放该会话的手动叶子（树页点节点切分支的钉子）并把活跃链锚回文件尾；有活动句柄时尽力把运行时叶子同步回文件尾（流式中可能被 pi 拒绝，不阻塞应答）；
- **`latestEntryId`**：最新叶子的条目 id（与 `tree` 帧 `leafId` 的 `getLeafId()` 同源，**不受手动叶子影响**）。并入 live 未落盘尾部时取 live 叶子（与活跃链尾同源，客户端已显示 in-flight user，仍报文件水位会误报“落后于最新”）；无 live 并入且文件还没有叶子时可为 `null`，不伪造水位；客户端拿非空值与活跃链尾比对，落后即说明主线有更新的消息，应提供“跳到最新”出口（重新发起带 `resetLeaf` 的 history）；
- **每页序列化字节上限 2 MiB**（`bytes` 字段 = 该页 `messages` 序列化大小，不含应答外壳；保最新、弃最旧，超出部分并入 `hasMore`）；`limit` 默认 100、上限 400；
- **单条消息上限 512 KiB**：超限消息先降损（图片 base64 → 元数据占位 `dataOmitted`/`dataBytes`，超长文本截断加 `[已截断]` 尾标），仍超限则整条替换为 `{role:"custom","customType":"wire-oversized",content:"[消息过大，移动端已省略]"}`——因此 2 MiB 页上限恒成立；被剥图的完整内容随后用 `attachment` 帧按需取回（§4.22）；
- 消息里 assistant 的工具调用块已从文件格式（`{id,name,arguments}`）归一为运行时格式（`{toolCallId,toolName,input}`），与实时 `message_end` 一致；
- **`timestamp`（epoch 毫秒）**：`message` 条目由 pi 自带、网关原样透传；`compaction`/`branch_summary`/`custom_message`/`custom` 由条目 ISO 时间换算。客户端必须把缺省当成“时间未知”（不得参与耗时差值），否则历史项与实时事件混在同一组时会算出 `now - 0` 这种荒谬耗时；
- **历史来源 `entryType`**：Pi `compaction`、可见/隐藏的 `custom_message`、网关超限占位分别标为 `compaction` / `custom_message` / `wire_oversized`。客户端据来源区分消息，不能用扩展自选的 `customType` 判断原生压缩或上游错误；无来源字段的旧消息只可按可见文本保守显示。Pi `custom` 是内部数据，一律不转 history 消息，包括旧 `empty-stop-retry` 特例。
- **`custom_message` 条目**（role=custom + `content`/`display`）：**始终进入模型上下文**（这是扩展注入隐藏续跑指令的机制），`display` **只控制 UI 渲染**——`display=false` 表示**完全隐藏**（pi TUI 同样不渲染），客户端必须跳过、不得渲染；仅 `display=true` 时按普通自定义消息处理；缺省与 false 均隐藏（对齐 Pi TUI）；
- `model`/`thinkingLevel`：有活动句柄取实时值，否则从文件条目回溯推导；`isStreaming` 只有句柄在内存时才可能为 true；
- `queuedMessages`/`contextUsage`：文件回溯时为空/null。

### 4.7 `state` — 轻量状态轮询

```json
{"type":"state","sessionId":"<uuid>"} → {"kind":"state","sessionId":"…",
  "isStreaming":false,"isCompacting":false,"model":{…}|null,"thinkingLevel":"…",
  "queuedMessages":{…},"contextUsage":{…}|null}
```

用于断线重连/页面切回时的对账（pi-web 同款 reconcile 思路）：客户端轮询 state，发现 `isStreaming` 则重订阅 + 重取 history 尾部。

### 4.8a `dequeue` — 取回未执行队列，保持当前运行

```json
{"type":"dequeue","sessionId":"<uuid>","queueRequestId":"<本次唯一ID>"}
→ {"kind":"dequeued","sessionId":"<uuid>","queueRequestId":"<同一ID>","queued":["steer text","follow-up text"],"isStreaming":true,"isCompacting":false,"queuedMessages":{"steering":[],"followUp":[]}}
```

仅在 hello.capabilities 包含 `dequeue` 时使用。`sessionId` 与非空、最长128字符的 `queueRequestId` 必填；校验失败不清队列，错误应答回显有效的关联ID。网关在同会话prompt admission串行区调用公开SDK `clearQueue()`，整批取回当时尚未消费的steering→followUp文本，不调用abort、不重新入队、不停止当前回答或工具。已被Pi消费的消息不在取回载荷中；无活动句柄或队列已空返回空数组，不加载/创建会话。

`queued` 是本次取回文本，`queuedMessages` 是取回后的真实状态；客户端仅凭同会话、同queueRequestId的回执合并到当前草稿前，以双换行分隔并保留新附件，不自动发送。取消的队列不再各自settled，客户端扣除对应待运行计数，但流式/压缩中的当前运行必须继续保活。SDK仅支持整批文本取回，未提供逐项/排队图片恢复；取回后断线丢回执也不保证跨连接恢复。手机不得通过清空再重排实现伪逐项撤回。

### 4.8 `abort` — 中止当前运行

```json
{"type":"abort","sessionId":"<uuid>","restoreQueued":true}
→ {"kind":"aborted","sessionId":"…","isStreaming":false,"isCompacting":false,
   "model":{…}|null,"thinkingLevel":"…","contextUsage":{…}|null,
   "queuedMessages":{"steering":[],"followUp":[]},"queued":["取回的文本"]}
```

等待会话真正空闲后应答，并附当前 state 形状。会话未加载（必不在运行）也返回空闲快照。

`restoreQueued:true` 对齐 Pi TUI Esc：在同会话 prompt admission 串行区内，先用公开 SDK `clearQueue()` 取走尚未消费的 steering/followUp 文本，再中止运行；`queued` 按 steering→followUp 顺序返回，客户端以双换行合并到当前草稿之前，不自动重发。`queuedMessages` 是清理后的当前队列，不能和取回载荷 `queued` 混用。`queue_update` 仍是原生事件，不伪造 Agent 终态；空闲残留队列也可取回。SDK 1.3.0 的取回 API 仅返回文本，不承诺排队图片恢复。断线丢失回执时不能保证取回内容跨连接恢复。

省略/false 保留旧版只停止语义，不清队列，也不返回 `queued`，避免旧客户端无法接收文本而丢稿。旧网关忽略该请求扩展时只回旧 `aborted`，新客户端不得凭本地队列快照假装已撤销。

- 对未加载会话的 `message`/`subscribe` 会触发按需加载（含扩展绑定，毫秒级～秒级）。

### 4.9 `directories` — 宿主机目录列表（工作区选择器）

```json
{"type":"directories","path":"/可选绝对路径，缺省为 home"}
→ {"kind":"directories","path":"…","home":"…","crumbs":[…],"entries":[…],"truncated":false}
```

- `entries` 只含**子目录**（文件夹选择器语义）：`{name, path, hidden}`，`hidden` 标记点开头目录；
- `crumbs` 为从根到当前目录的面包屑链（含当前目录），客户端以倒数第二个元素作为上级目录；
- 条目按名称排序，超过 500 条截断并置 `truncated: true`；
- `path` 必须是绝对路径，不存在/不是目录分别回 `directory-not-found` / `directory-not-directory`；无权限回 `directory-permission-denied`，其他分类见统一错误码。

### 4.10 `directory-create` — 新建文件夹

```json
{"type":"directory-create","path":"/父目录","name":"新文件夹"}
→ {"kind":"directory-create","path":"/父目录/新文件夹","created":true}
```

父目录必须存在且为目录；`name` 不得为空/`.`/`..`/含分隔符。已存在同名目录返回 `created:false`。名称不合法回`directory-name-invalid`，同名非目录回`directory-name-conflict`；权限/只读/空间不足分别按统一错误码返回。

### 4.11 `workspace-create` — 创建工作区（新会话的 cwd）

```json
{"type":"workspace-create","path":"/abs/path"}
→ {"kind":"workspace-create","workspace":{"workspaceId":"/abs/path","path":"/abs/path","title":"path"}}
```

等价 `mkdir -p`（缺级自动补建），返回以规范化绝对路径为 `workspaceId` 的工作区对象。

### 4.12 会话生命周期语义（客户端须知）

- 网关在内存中按需加载会话（订阅/发消息时），空闲且无订阅者 5 分钟后释放；**运行中的会话即使手机断线也跑完**（pi 在电脑上跑，手机只是遥控器）；
- 加载句柄数上限 16：超限时淘汰最旧的"无订阅者且空闲"句柄（运行中/有订阅者的永不被淘汰）；被淘汰会话的下次访问自动重新加载；
- 同一会话的并发加载/新建（双击连发、多设备同时订阅）共享一次构建，不产生重复会话；
- 重连恢复流程：`history`（首页）→ `subscribe` → 若 `isStreaming` 则拼接收尾事件；事件 seq 只保证单次加载生命周期内单调；
- 对未加载会话的 `message`/`subscribe` 会触发按需加载（含扩展绑定，毫秒级～秒级）。

### 4.13 `models` — 可用模型目录

```json
{"type":"models"}
→ {"kind":"models","groups":[
   {"provider":"relayB","models":[
     {"id":"example-model","name":"example-model","contextWindow":1000000,"maxTokens":131072,
      "reasoning":true,"input":["text"],
      "thinkingLevels":["off","minimal","low","medium","high"]}
   ]}
 ]}
```

- 只含**已配置认证**的模型（pi `ModelRuntime.getAvailable()`）；按 provider 分组，provider 与组内模型均按其 id 排序；
- 全局 settings 的 `enabledModels` 非空时，目录**按 pi TUI 选择器同口径过滤**（复用 pi `resolveModelScopeWithDiagnostics`：支持 `provider/model` 精确项、glob 通配与 `":level"` 后缀；部分无命中的 pattern 省略；全部无匹配则按Pi空scope回到可用目录）；未配置或空数组时不过滤；SDK reload读取失败保留上次有效设置；手机默认只显示已启用范围，不自动增加全部目录切换；
- `input` 为封闭集合 `["text"]` 或 `["text","image"]`（缺失或未知模态回退为 `["text"]`）；`reasoning` 表示该模型是否支持推理；
- `thinkingLevels` 是该模型**实际可用**的推理档位，与 pi `getSupportedThinkingLevels()` 一致：非推理模型只有 `["off"]`，`xhigh`/`max` 仅在模型显式映射时才出现；
- 该帧只读，不改变任何状态；客户端用它渲染模型选择器。

### 4.14 `set-model` — 切换会话模型

```json
{"type":"set-model","sessionId":"<uuid>","provider":"relayB","modelId":"example-model","thinkingLevel":"high"}
→ {"kind":"model-set","sessionId":"…","isStreaming":false,"isCompacting":false,
   "model":{"provider":"relayB","modelId":"example-model"},"thinkingLevel":"high",
   "queuedMessages":{"steering":[],"followUp":[]},"contextUsage":{…}|null}
```

- **会话级**：只影响该会话（pi `setModel(model, {persist:false})` 追加 `model_change` 条目，重连/resume 后保持），**不改全局默认模型**；
- `thinkingLevel` 可选。pi 在切换模型时会把档位重置为新模型默认值，所以网关在 `setModel` **之后**才应用它，应答回传**实际生效**的档位（模型不支持时 pi 会就近收敛）；
- 会话未加载时自动按需加载（同 `message`/`subscribe`）；
- 错误：`sessionId`/`provider`/`modelId` 缺失或 `thinkingLevel` 非法 → `bad-request`；模型不在目录中或 provider 无凭据 → `bad-request`（pi 的校验消息原样返回）；会话不存在 → `session-not-found`；
- 成功应答就是一次 `state` 快照，客户端可直接用它刷新界面，无需再发 `state`。

### 4.15 `name` — 会话改名

```json
{"type":"name","sessionId":"<uuid>","name":"新标题"}
→ {"kind":"session-named","sessionId":"…","name":"新标题", …state 快照}
```

- 对齐 pi 原生 `/name`：调用 pi `setSessionName`，**持久**落到会话文件；`sessions` 索引的
  `name` 随之更新（客户端列表 `displayTitle` 优先 `name`）。应答帧带 `name`，
  客户端以单一数据流刷新会话列表与标题。
- 错误：`sessionId`/`name` 缺失、`name` 为空或超过 200 字符 → `bad-request`；未知会话 →
  `session-not-found`；pi 侧校验失败 → `bad-request`（消息可回显）。

### 4.16 `compact` — 手动压缩上下文

```json
{"type":"compact","sessionId":"<uuid>"}
→ {"kind":"compact-started","sessionId":"…", …state 快照}
```

- 对齐 pi 原生 `/compact`：`session.compact()` 会**先中止当前运行**再开始压缩流程（当前
  对话中未完成的回答会被中断）；`compaction_start` / `compaction_end`（含 `aborted`、
  `willRetry`）事件本就随事件流透传，网关的 `isCompacting` 在受理时置位、调用收尾时复位。
- 本帧**只确认受理**（fire-and-forget）。`isCompacting` 覆盖此次手动压缩调用的完整在途期，
  包括 SDK 等待当前回答停止的启动期；同一会话在途重复请求只回当前状态，不再次调用 SDK。
- 完成/失败/中止由 Pi 原生事件及最终 `state` 核实；调用收尾会主动向订阅者推送 `compact-finished` 状态通知，
  即使启动前异常或未产生 Pi 事件也会释放 busy。断线重连可查询 `state`，无需轮询。
  失败详情仍由 Pi 原生失败事件/网关日志提供，受理不等于成功。
- `compact-finished` 携带 `sessionId`、`isStreaming`、`isCompacting` 及其余state字段，
  表示手动调用已收尾，不保证成功。它是当前连接上的独立通知，不认领或释放`state`请求；
  缺少非空`sessionId`或两项明确布尔状态的通知不应用；其余快照字段沿用state格式。
  既有`state`请求/回执的严格关联保持。

- SDK实际压缩阶段（停止当前回答之后）提交`message`会得到Pi的压缩中错误，网关回`bad-request`。
  等待停止的启动期仍按Pi原生输入/排队语义处理；手机依据网关的完整在途状态禁用新发送。
- 错误：`sessionId` 缺失 → `bad-request`；未知会话 → `session-not-found`。

### 4.17 `providers` / `provider-put` / `provider-delete` — 模型 provider 管理

Provider公共`baseUrl`是默认值，模型级`baseUrl`可覆盖；完整路径按用户配置原样保留，不自动增删`/v1`或按中转站/模型名称改写。`provider-model-base-url-v1`能力下，providers逐模型回传`baseUrl`（null表示继承），provider-put的模型字段省略=保留宿主值，字符串=显式覆盖，null=删除覆盖并恢复继承。旧客户端省略该字段时保留同ID宿主模型地址。

连接测试按请求模型ID选择协议与凭据。新的`provider-test.modelBaseUrl`为草稿三态：省略沿用旧客户端的宿主覆盖优先规则；字符串直接测试该模型草稿覆盖；null显式按表单公共地址（缺省回退宿主公共地址）测试继承，不借用旧模型覆盖。草稿测试不写models.json。拉取模型清单仍只使用Provider公共地址，不借用模型级地址。

手机可读写 pi 的 `~/.pi/agent/models.json`（凭证盲读出，写入走原子替换）。模型定义与选择范围分离：保存Provider不追加`providerId/*`，菜单默认范围由全局settings.json的enabledModels决定；空范围延续Pi可用目录回退。手机全局范围编辑见§4.23；会话临时范围仍由Pi的/scoped-models管理。

**生效时机**：`models.json` 是 pi 的进程级配置面（`ModelRuntime.create()` 读一次），因此 `provider-put`/`provider-delete` 在落盘后会触发 pi 的 `ModelRuntime.refresh({allowNetwork:false})`——该调用**原地**重组合 provider 并刷新可用性快照，网关内所有存活会话共享同一 runtime 实例，故新 provider 对模型菜单与已有会话的切模型同时生效，无需重启网关或重建会话（实测 `refresh` 毫秒级返回）。这与 pi 原生一致（TUI `/login` 保存凭证后、打开模型选择器时都调用同一刷新路径）。

**外部编辑同样生效**：网关是长驻进程，而 `models.json` / `settings.json` 是用户的编辑面。`models` / `providers` 帧在读取前先比对配置文件的 `(mtime, size)`（`statSync`），变了才重读（settings 用 pi 的 `SettingsManager.reload()` 同实例重载；写路径同样先重载再合并，避免陈旧内存覆盖用户手改）。因此在编辑器里直接改这两个文件（或桌面 pi、其他客户端改动）后，**打开模型菜单 / provider 列表即最新**，无需重启网关。刻意不用 `fs.watch`：它在各平台静默失败（Windows 缓冲区溢出丢事件/映射盘/原子保存使句柄失效、macOS kqueue 递归差、Linux inotify 上限与 NFS/CIFS 不触发、WSL 跨边界、容器 bind mount 传播不一致），正确性不能依赖平台通知机制。

```json
{"type":"providers"}
→ {"kind":"providers","providers":[
   {"id":"relayB","name":"relayB","baseUrl":"https://…/v1","api":"openai-completions",
    "apiKeySet":true,"active":true,"status":null,"models":[
      {"id":"example-model","name":"Example Model","contextWindow":1000000,"maxTokens":131072,
       "reasoning":true,"thinkingLevelMap":{"off":null,"max":"max"},
       "compat":{"supportsStore":false,"maxTokensField":"max_tokens","thinkingFormat":"deepseek"}}]}]}

{"type":"provider-put","id":"relayA","baseUrl":"https://…/v1","apiKey":"sk-…",
 "models":[{"id":"m1","api":"openai-completions","name":"M1","contextWindow":200000,
 "maxTokens":65536,"reasoning":true,
 "thinkingLevelMap":{"off":null,"low":"low","medium":"high","high":"high"},
 "compat":{"supportsStore":false,"maxTokensField":"max_tokens"}}]}
→ {"kind":"provider-saved","provider":{…},"refreshed":true}

{"type":"provider-delete","id":"relayA"}
→ {"kind":"provider-deleted","id":"relayA","refreshed":true}

{"type":"provider-test","id":"relayA","model":"m1","providerTestId":"probe-1"}
→ {"kind":"provider-test-result","id":"relayA","providerTestId":"probe-1","ok":false,"latencyMs":210,"httpStatus":200,
   "code":"html-response","failureKind":"config","error":"地址返回了网页"}
```

- `providers` 读出**不回传 apiKey 原文**（只给 `apiKeySet` 布尔）；`baseUrl`/`api`/每个模型的 `thinkingLevelMap` 与 `compat` 原样返回，供 App 表单回显；
- `compat` 只暴露手机可编辑子集：布尔开关（`supportsStore`/`supportsDeveloperRole`/`supportsReasoningEffort`/`requiresReasoningContentOnAssistantMessages`/`forceAdaptiveThinking` 等）与字符串枚举（`maxTokensField`/`thinkingFormat`/`thinkingTokenBudgetField`/`cacheControlFormat`/`deferredToolsMode`/`sessionAffinityFormat`）；嵌套对象（`chatTemplateKwargs`/`openRouterRouting` 等）留在宿主侧，不上手机；
- `provider-models` 拉取上游 `/models` 清单（应答 `provider-models-result`：`{id, ok, ids[], httpStatus?, url?, error?, failureKind?}`）。**必须走网关**：手机是凭证盲的，保存过的 provider 其 apiKey 只存在宿主 `models.json` 里，编辑时表单为空，客户端直连必然 401（实测症状是"测试连接能过、拉取模型报 401"——前者本来就走网关）。凭据口径与 `provider-test` 一致：表单 Key 优先、缺省回退已存 Key；地址只使用 Provider 公共地址，因此**不需要用户为拉一次列表重新输入 Key**。端点按协议区分（anthropic `/models?limit=100` + `x-api-key`、google `/models` + `x-goog-api-key`、其余 `/models` + `Authorization: Bearer`），响应兼容 `{data:[{id}]}` / `{models:[{name}]}` / 裸数组；
- `provider-put` 是**合并 upsert**（兄弟 provider 不受影响）：托管字段（`name`/`baseUrl`/`api`/`models` 全量、`compat`）以手机提交为准，**缺省保留原值**；`apiKey` 缺省时**保留原值**（手机凭证盲无法重发；清 Key = 删 provider 重建或电脑端编辑）；每个模型按 `id` 合并，宿主侧字段（`headers`、`cost`、未上手机的 compat 键）在重发同 id 模型时保留；模型级 `baseUrl` 缺省保留、字符串覆盖、显式 null 删除以恢复继承；`id` 必填；`baseUrl`/`apiKey` 至少其一；`baseUrl` 必须 `http(s)`；`api`（provider 级）无缺省兜底，缺省保留原值（协议按下方「协议层级」写模型级）；`models` 可为数组（`id` 必填）；模型条目非法 → `bad-request`；models.json 读取/写入失败 → `bad-request`（客户端可操作消息）；
- **协议层级（App 契约）**：wire 协议属于**模型级**（pi 的解析顺序 `model.api` > `provider.api` > 内置默认，运行时只按 `model.api` 分派流实现），App 把协议**逐模型**写入 `api`（同一 provider 下可混用多种 API，例如中转站的 GPT 走 `openai-completions`、Claude 走 `anthropic-messages`），`provider-put` 不发 provider 级 `api`（缺省保留原值）。网关仍兼容 provider 级 `api` 字段（供手编/目录刷新数据）；App 回显时以模型级 `api` 为准，模型未写才回退到 provider 级，保证改表单不会静默改变生效协议；compat 键集跟随该模型自己的协议。
- Provider保存不自动追加`providerId/*`到settings.enabledModels；模型定义与/model默认scope分别管理。旧admitted字段仍可被旧客户端读取，新应答省略该字段。手机视图调序也不写宿主模型顺序；
- **enabledModels 的删除同步**：保存时不追加范围；本次编辑里**被删掉的模型行**会把它们的**具体** pattern（`providerId/<模型id>`）一并清掉，`provider-delete` 则清掉该 provider 的**所有** pattern（`providerId/*` 与 `providerId/<模型id>`）。否则只会留永不命中的死 pattern（具体模型 pattern 不含通配符、不走 glob，所属模型没了就彻底无用）；
- `provider-test` 使用当前草稿的有效模型 ID、协议、地址与凭据发送一次最小非流式生成请求；缺省字段按已存配置回退，编辑时不要求重填 Key。支持 `openai-completions`、`openai-responses`、`anthropic-messages`、`google-generative-ai`；未知协议明确返回 `unsupported-api`，不猜测兼容协议。按协议拼接请求路径，不自动增删 `/v1`。请求不跟随重定向，12s 超时，响应体上限 64KiB。
- 测通要求 HTTP 成功且存在对应协议的有效模型输出；空 JSON、模型清单、网页、纯文本、错误体不能算成功。它只验证最小模型请求，不认证流式、工具、图片、思考档位或容量上限。
- `provider-test-id-v1` 宣告逐探针关联：请求可携带 `providerTestId`（1–128 字符）；成功/失败结果和关联错误均原样回显。旧客户端省略该字段仍兼容；新客户端要求该能力，以标识匹配当前请求，超时后迟到回执不能认证下一次测试。诊断字段本身不作为请求标识。
- 测试响应保留 `ok`、`latencyMs`、`httpStatus?`、`failureKind?`，失败新增可选 `code` 和短 `error`；不回显地址、重定向目标或原始上游错误。`code` 可为 `invalid-url`、`missing-model`、`unsupported-api`、`auth-rejected`、`access-denied`、`not-found`、`payment-required`、`rate-limited`、`upstream-error`、`request-rejected`、`model-unavailable`、`insufficient-quota`、`redirect`、`html-response`、`invalid-response`、`timeout`、`dns-failed`、`tls-failed`、`connection-refused`、`network-error`。客户端按稳定码及状态码组织诊断；旧网关没有 `code` 时按状态码降级，不展示原始错误。
- `provider-put` 成功后，连接配置（公共/模型地址、API、Key、headers、模型集合）改变时清除过期诊断，恢复“无记录＝激活”；仅改名称、窗口或其他数值元数据时保留状态。草稿测试结果只给当前表单通行证，不提前认证另一份已存配置；保存后不自动再测，避免重复真实请求。
- `refreshed:false`（两个应答都带）表示网关触发 pi **重读 models.json 未完全成功**：refresh 抛错，或 pi 报出模型配置错误。注意 pi 对坏 models.json **不抛错**（`ModelConfig.load` 返回带 error 的空配置、目录静默降级为空），因此网关在 refresh 后另读 `getError()` 才能区分“真刷新成功”与“静默降级”。两种情况保存/删除均已落盘，但运行时目录可能未更新，可在电脑端检查 models.json 后重启网关；缺省视为 `true`（旧网关无此字段，旧客户端忽略）。
- `provider-delete` 删除未知 id → `bad-request`；同步移除 `providerId/*` pattern（清理已失效pattern；不自动收录新增模型）；同时清除该 provider 的测试状态；
- **激活状态**：`provider-test` 只有实际探测配置与应答时当前已存模型的有效地址、API和Key一致时，结论才写入网关自己的 `provider-status.json`（与设备注册表同目录，**不动 models.json**）；草稿预览或在途宿主改动仅回测试结果，不认证盘上另一份配置。`providers` 帧的 `active`/`status` 即由此投影；`active:false`（测过且**配置类**失败）的 provider 在手机端灰显，**不再据此从 `models` 应答删模型**（2026-10-07 PROV01：菜单只按 Pi getAvailable 与 settings.enabledModels 选择）。**无记录的 provider 一律视为激活**（包括用户在电脑上手工添加的），避免把既有配置隐藏掉。
- **失败归因（重要）**：测试结果带 `failureKind`。`config` = 需用户改配置（返回网页 HTML、404、401/403、非 JSON、上游 `error`）；`transient` = 上游临时问题（**超时、5xx、429**）。**`transient` 不记为成功：保留旧成功记录，只清除过期失败记录，诊断恢复为无记录（激活）**——实测中转站响应 2s～>12s 波动，把超时当配置错会让“手点测试成功后过一会儿自动变失败”（保存触发的自动测试撞上慢响应），模型还会从菜单里消失。`transient` 失败仍会在 `provider-test-result` 里回 `ok:false` + 原因，App 可提示“上游较慢/暂时不可用，不代表配置错误”。
- 能力宣告：`hello.capabilities` 含 `providers`/`provider-put`/`provider-delete`/`provider-test`，旧客户端可据此隐藏入口。

### 4.18 `tree` — 会话分支树

新增能力 `tree-view-v1`（仅升级网关宣告）：`tree` 请求可附 `view`：

```json
{"type":"tree","sessionId":"…","view":{"filter":"default","search":"","foldedIds":[]}}
```

- `filter` 必填：`default`、`no-tools`、`user-only`、`labeled-only`、`all`；`search` 为字符串，`foldedIds` 为非空条目ID字符串数组。非法参数返回 `bad-request`，不静默降级。
- 有 `view` 时按锁定 Pi SDK 1.3.0 的 `/tree` 规则筛选、排序、折叠并重新计算可见祖先和前缀，返回全部匹配节点，不使用旧400条窗口。请求不带 `view` 时保留旧投影与上限，兼容已有客户端。
- 默认隐藏 label/custom/model_change/thinking_level_change/session_info，保留工具结果、摘要、自定义消息等；纯工具/空白 assistant 除当前叶或异常结束外在所有模式均隐藏。`display=false` 不作为树过滤条件（与 Pi 树一致，独立于对话消息可见性）。
- 搜索不区分大小写，空白分词后 AND 匹配；按 Pi `getSearchableText` 使用标签、角色与类型特定正文。普通消息正文取前200字符，自定义消息字符串/摘要等遵循SDK各自规则，并非无限全文搜索。
- 新响应回显 `view`，附 `selectedId`（当前叶若不可见则最近可见祖先，否则末行；空结果为null）。每个节点附 `displayText`（Pi行正文的无ANSI版本，正文/角色标记已包含）、`foldable`、`folded`。客户端不再次解析Markdown或追加角色前缀。
- `prefix` 包含缩进、穿透线和 `⊟/⊞` 折叠字符；无分叉连接符的折叠根用 `⊞ ` 前缀。`onActivePath` 对应Pi的 `• `，`label`仍独立显示。折叠基于完整父链，过滤后按最近可见祖先重算布局；仅根或分支段首且有可见子节点可折叠，已折叠节点始终可展开。
- 新客户端只有发现明确 `tree-view-v1` capability才发送 `view`；旧网关继续使用基本树，提示升级才可用搜索/过滤/折叠。发布新APK不代表网关服务已更新。


以下是不带view的兼容接口：

```json
{"type":"tree","sessionId":"<uuid>"}
→ {"kind":"tree","sessionId":"…","leafId":"<entryId|null>","nodes":[WireTreeNode…]}
```

- 对齐 pi 原生 `/tree`：`sessionManager.getTree()` 投影——**全量 entries 按 parentId
  构树**（含被放弃的分支），children 按时间排序。`leafId` 为当前叶子（live 会话取
  pi `getLeafId`，离线取文件尾 id）。
- `WireTreeNode`：**扁平数组**（DFS 前序 = 渲染顺序，客户端按顺序直接画）——深链
  会话（实测 3400+ 条单链）的递归投影与嵌套 JSON 序列化都会爆栈，wire 用
  `{id, parentId, prefix, onActivePath, type, role?, preview, label?, timestamp?}`。
  - `parentId` 是**最近可见祖先**（pi `recalculateVisualStructure` 的
    `findVisibleAncestor`）：被过滤掉的中间条目（toolResult/model_change…）不会
    切断树。直接透出 `entry.parentId` 会让客户端拿到指向不可见条目的父 id 而断链
    （实测真实会话里 58/79、246/315 的可见节点如此），一棵树被切成几十个 root。
  - `prefix` 是树行前缀（缩进 + 穿透竖线 + 分叉字符），按 pi `tree-selector.js`
    的规则算好：每级 3 字符、只有分叉才缩进、单链平铺，`├─`/`└─`/`│`；被裁掉的
    祖先不影响前缀（逐行自带）。客户端用等宽字体拼在行首，零布局逻辑。pi 在每级
    第 2 个字符位放折叠标记（⊟/⊞），mobile 不支持折叠，恒为 `─`。
  - `onActivePath` 标记当前活跃路径（客户端渲染 `• `；pi 同样只标行、不标线）。
  - `preview` 单行摘要裁 120 字符；message 节点的文本**不带 `user: ` /
    `assistant: ` 前缀**（角色由 `role` 字段表达，客户端用自己的配色渲染短标签；
    `assistant: ` 占 11 字符，手机上会吞掉单行宽度），其余类型保留 `[...]` 标识。
- **与 pi TUI 有意不一致**：mobile 树只保留 `message` 的 user/assistant 两种
  entry（手机屏小，toolResult/compaction 等中间条目噪声大、无导航价值）；过滤后
  与 pi 的 hide-tools 一样按“最近可见祖先”重建可见树。
- 离线会话（未加载）也能返回（`SessionManager.open` 投影），`leafId` 取文件尾 id（分支切换后取手动叶子）。
- 错误：`sessionId` 缺失 → `bad-request`；未知会话 → `session-not-found`。

### 4.19 `switch-branch` — 切换分支

```json
{"type":"switch-branch","sessionId":"<uuid>","entryId":"<entryId>"}
→ {"kind":"branch-switched","sessionId":"…","entryId":"…","leafId":"…","alreadyAt":false,
   "editorText":null,"queued":[],"…state 快照"}
```

- 对齐 pi TUI `showTreeSelector` 的选择回调：
  - 目标即当前叶子 → **不导航**，回 `alreadyAt:true`（客户端提示 "Already at this
    point"，对齐 pi 原生文案）。
  - 压缩进行中 → 拒绝 `bad-request`（对齐 pi lane 忙时拒绝导航）。
  - 流式中：**先取走排队消息**（steering+followUp，pi TUI 会恢复进编辑器，mobile
    由客户端处理）→ **abort 当前运行** → `navigateTree(entryId, {summarize:false})`。
    mobile 固定 `summarize:false`（Summarize branch 不做）。
  - `editorText`：目标 entry 是 user/custom 消息时为目标内容（pi 语义：点 user 消息
    = 回到发送前重新问，文本回编辑器）；assistant 等其余类型为 `null`。客户端仅在
    输入草稿为空时恢复（对齐 pi `editor.getText().trim()` 判断）。
  - `queued`：切换前取走的排队消息文本；客户端按 pi 的合并语义（双空格连接）恢复。
- 历史重载由客户端自行发起（`history` 帧），与 pi 切换后 `renderInitialMessages` 对齐。
- 错误：`sessionId`/`entryId` 缺失 → `bad-request`；未知会话或**无活动会话句柄** →
  `session-not-found`（网关不隐式 `openSession`：客户端需先 `subscribe` 打开会话，
  再发 `switch-branch`）；压缩中/被拒绝 → `bad-request`。
- 能力宣告：`hello.capabilities` 含 `tree`/`switch-branch`，旧客户端可据此隐藏入口。


### 4.20 `restart-session` — 重载配置（重建会话）

```json
{"type":"restart-session","sessionId":"<uuid>"}
→ {"kind":"session-restarted","sessionId":"…","…state 快照"}
```

- 对齐桌面 pi `pi --session <id>` 重开语义（SDK `createAgentSession` 内
  `resourceLoader.reload()`）：AGENTS.md/settings/extensions/skills/prompt
  templates/themes **全部新鲜读取**；消息历史从会话文件重放，model 由
  `model_change` 条目恢复。**区别于桌面 `/reload`**：`thinkingLevel` 不在
  会话文件持久化，重建后回落 settings 默认值。
- **与 `history`（重新加载历史）的区别**：`history` 只是客户端重新拉显示
  内容（视图层重同步，AgentSession 不动、配置不重读）；`restart-session`
  重建会话实例本身，是配置变更生效的唯一路径。
- 流式中（`isStreaming`/`isCompacting`）→ 拒绝 `session-restart-busy`：
  重建会中断进行中的 run，不做隐式中断。
- 手动叶子（`manualLeafIds`）随旧运行时视图一并释放（文件视图回文件尾）。
- 事件订阅者迁移到新 handle；`seq` 从头计数，客户端随后以 `history`
  （`resetLeaf:true`）完成会话视图重建（与重连 catch-up 同通道）。
- 错误：`sessionId` 缺失 → `bad-request`；运行中 → `session-restart-busy`；
  未知会话 → `session-not-found`（对未加载会话直接 `openSession` 重建，等价
  于空闲回收后的重开路径）。

### 4.21 `commands` — 自定义命令清单

```json
{"type":"commands","sessionId":"<uuid>"}
→ {"kind":"commands","sessionId":"…","commands":[WireSlashCommand…]}
```

```json
// WireSlashCommand（字段缺省即无，不传 null）
{"name":"eval","description":"…","source":"prompt",
 "scope":"project","origin":"top-level","argumentHint":"[target]"}
{"name":"skill:grilling","description":"…","source":"skill",
 "scope":"user","origin":"package","disableModelInvocation":true}
{"name":"review","description":"…","source":"extension",
 "scope":"user","origin":"package"}
```

- 三源（对齐 pi RPC `get_commands`）：扩展命令（`invocationName`，同名冲突
  pi 已裁决加 `:N` 后缀）、提示词模板（`~/.pi/agent/prompts` 与项目
  `.pi/prompts` 的 md 文件，`argumentHint` 来自 frontmatter）、skills
  （`skill:` 前缀，`disableModelInvocation` 仅展示用）。`scope`/`origin`
  来自 pi `SourceInfo` 供客户端分组徽章；宿主机绝对路径不传（最小暴露）。
- 清单是会话级（随会话 cwd 与扩展加载状态）：`sessionId` 必填，未加载
  会话按需加载；`restart-session` 重读全部资源，客户端收到
  `session-restarted` 后须重拉；重连后重拉一次（廉价）。
- **TUI 内建命令（`/model` `/compact` 等）不在 session 层，不在此列**，
  客户端继续自管内建提示表。
- **执行 = `message` 原文透传**，不另设执行帧：网关把 `/名 参数` 原样交
  `session.prompt()`，pi 按扩展命令 → skill 展开 → 模板展开 → 发模型
  的顺序分发（与 TUI 一致）。扩展命令 handler 执行完毕后才回 `sent`
  （受理即完成）；模板/skill 的 `sent` 仅受理，后续走正常 run 事件流；
  handler 抛错走 `extension_error` 事件。未知 `/xxx` 维持透传给模型。
- trust 现状（非本接口新增，写明）：SDK 无头路径 `projectTrusted`
  默认为 true，桌面 trust 记忆不生效；手机指到任意 cwd 建会话，该目录
  的 `.pi/extensions` 可执行代码即加载。收紧 trust 是独立安全议题。
- 错误：`sessionId` 缺失 → `bad-request`；未知会话 →
  `session-not-found`。能力宣告：`hello.capabilities` 含 `commands`。

### 4.22 `attachment` — 历史图片按需读取

```json
{"type":"attachment","sessionId":"<uuid>","entryId":"<entryId>","imageIndex":0}
→ {"kind":"attachment","sessionId":"…","entryId":"…","imageIndex":0,
   "mediaType":"image/png","bytes":12345,"dataBase64":"<base64>"}
```

- **寻址是三元组，不是路径**：客户端只能按 `sessionId + entryId + imageIndex`
  取本会话历史消息里的原图。`imageIndex` 是该 user 消息 `content` 里**所有
  image 块**的 0-based 序号（与 `message` 帧上传时的 `images` 数组顺序一致）。
  不接受任意路径/URL；`attachmentId` 不参与授权，只服务于客户端本地缓存/
  预览关联；
- **能力宣告**：`hello.capabilities` 含 `attachment`。客户端不发缺 capability
  或缺 `entryId` 的请求，失败不循环重试（失败终态见下）。Android 取图超时只
  结束该请求，不主动回收其他请求所在的连接；这是有完整条目关联的只读请求，
  迟到的其他图片应答可直接忽略。传输断线与出站背压仍按原连接规则处理；
- **大小上限**：单图原始字节 ≤ 4 MiB。超过即失败（`attachment-too-large`），
  不发送巨大帧——超限路径绝不先把 base64 装进响应。回复 base64 约 5.33 MiB
  加少量元数据，低于出站 8 MiB 背压阈值；但 `bufferedAmount + 帧大小 > 8 MiB`
  的整体断连语义原样保留（与其他积压帧相加后仍可能触发），**不宣称弱网永不
  掉线**。history/event 预算（2 MiB/1 MiB）与本上限无关，不放宽；
- **读取路径**：优先该会话的 live `SessionManager`（覆盖新会话尚未落盘的
  消息）；live 不存在或其中找不到该 entry 时，改读该会话当前**文件视图**
  （桌面 pi 后来追加的条目 live 内存快照可能看不到）。读取只用 pi 公开
  `SessionManager.getEntry()`，不为读图创建 `AgentSession`/触发模型；
- **归属校验**：条目的 session 身份必须匹配；entry 存在但不是 user 消息、或
  `imageIndex` 越界（该消息没有第 N 张图）→ `attachment-not-found`。纯校验
  失败不加载会话运行时；
- **mime 校验**：只接受有界的 `image/*`；否则 `attachment-invalid`。base64
  先过长度上限再做合法性/解码校验，解码失败同样 `attachment-invalid`；
  `bytes` 是解码后实际字节数（声明与实际一致）；
- **错误帧**沿用统一 error 骨架，`requestType:"attachment"`。有效三元请求的
  错误带完整 `sessionId`/`entryId`/`imageIndex` 关联；三元字段缺失、非法或
  超界时回 `bad-request`，不回显不合法字段。未知会话 →
  `session-not-found`；entry 不存在/非 user/
  索引越界 → `attachment-not-found`；原始字节 > 4 MiB → `attachment-too-large`；
  mime 非法/解码失败 → `attachment-invalid`；其余内部失败 → `internal`。

```json
{"kind":"error","code":"attachment-not-found","message":"…",
 "requestType":"attachment","sessionId":"…","entryId":"…","imageIndex":0}
```

---

### 4.23 `model-scope` / `model-scope-put` — 全局保存的模型范围

能力为`model-scope-v1`，与Provider定义及会话当前模型分开。只读请求`{"type":"model-scope"}`返回`{"kind":"model-scope","scope":{...}}`：scope包含原始`patterns`、未按scope过滤的可用目录`groups`（同models白名单）、已解析的`selected`（provider/modelId/可选thinkingLevel）与`unmatchedPatterns`。空或全无匹配范围按Pi默认选中全部可用模型；未匹配的旧条目单列，不能静默丢掉。 精确引用、裸ID歧义、思考后缀和通配符直接使用锁定Pi SDK的公开解析器；裸ID匹配多个Provider时保留官方解析出的全部模型，不另设大小写优先规则。读取、菜单、保存回执和新会话初始化采用相同规则。

显式保存请求：`{"type":"model-scope-put","scopeRequestId":"本次标记","expectedPatterns":["原始条目"],"models":[{"provider":"relay","modelId":"example","thinkingLevel":"medium"}],"preserveUnmatched":true,"reset":false}`。按勾选顺序写具体`provider/model[:thinkingLevel]`，不自动新增provider通配符；preserveUnmatched仅保留读取时既有的无匹配条目。reset=true明确恢复Pi默认范围（enabledModels=[]），不是零个可用模型；非reset空选拒绝。

保存串入既有settings写队列，先重读全局配置并核对expectedPatterns；电脑端/其他设备已改范围时回`scope-conflict`，不覆盖。只调用Pi公开SettingsManager，flush并重新读取确认落盘，其他settings字段保留；成功回`model-scope-saved`带scope及scopeRequestId，错误同样回本次标记。菜单及会话循环范围更新，但不调用setModel、不改变当前/历史会话模型；临时范围和项目范围不在此接口。

### 4.24 `input-resources` — Skills / Prompt 输入候选

```json
{"type":"input-resources","queryId":"resources-1","sessionId":"<uuid>"}
```

首页预览使用 `cwd` 代替 `sessionId`；两者必须且只能提供一项。`cwd` 必须是已存在的绝对目录；已有会话的 cwd 由宿主取，客户端不能覆盖。`queryId` 为非空字符串，最长128字符；成功与业务错误均回显它。

```json
{"kind":"input-resources","queryId":"resources-1","sessionId":"…","cwd":"/project","mode":"session","complete":true,"skillCommandsEnabled":true,"commands":[{"name":"skill:audit","source":"skill","description":"…","disableModelInvocation":true},{"name":"eval","source":"prompt","description":"…","argumentHint":"[target]"}],"shadowed":[],"omitted":[]}
```

- 会话清单来自 SDK 会话已加载的资源；未加载时允许恢复已有 SDK 会话，查询不自动重载。返回 Skill 与 Prompt 元数据，不发送文件正文或资源文件绝对路径。扩展命令不作为此次产品候选；与扩展 invocationName 重名，或模板名与已加载的 `skill:name` 重名时，从 `commands` 移到 `shadowed`（`name/source/by`，`by` 为 `extension` 或 `skill`），对齐 SDK 的扩展→Skill→Prompt 顺序。
- `enableSkillCommands=false` 时隐藏技能候选，手动显式 `/skill:name` 仍由 SDK 处理。`disableModelInvocation=true` 不隐藏显式调用候选。
- 首页为 `mode:"preview"` / `complete:false`，预览已有本地/配置路径，沿用 SDK 解析、来源优先级和禁用规则。`omitted:["packages","extensions"]` 明确不包含 Package 与扩展动态资源；内存设置快照去掉包配置，不安装包、不执行扩展或建立临时 AgentSession。预览不能宣称完整可调用性，首条创建会话后必须用会话清单替换。
- 错误带 `queryId`：`bad-request` / `session-not-found` / `input-unavailable` / `input-timeout` / `internal`；内部失败详情只写网关日志。
- 提交仍走 `message → session.prompt()` 原文链路，由 SDK 展开技能和参数、运行输入处理器及忙时队列。不新增手机正文展开或绕过 SDK 的执行端点。`complete` 表示清单归属，不承诺提交必然启动模型运行。

### 4.25 `input-completions` — 宿主 @ 文件 / 目录补全

```json
{"type":"input-completions","queryId":"files-1","sessionId":"<uuid>","token":"@docs/gu"}
```

上下文与 `queryId` 规则同上，首页用已选 `cwd`。`token` 只传光标前当前 `@` 片段，最多2048个 UTF-16 单元，不传完整草稿。空字符串取消本连接上次文件搜索并回复空列表；非空片段以 `@` 开头，空格路径使用 Pi 的双引号格式。

```json
{"kind":"input-completions","queryId":"files-1","sessionId":"…","cwd":"/project","token":"@docs/gu","prefix":"@docs/gu","items":[{"label":"guide.md","path":"docs/guide.md","type":"file","insertText":"@docs/guide.md ","cursorOffset":15,"consumeClosingQuote":false}]}
```

- 复用 Pi TUI 公开 `CombinedAutocompleteProvider`，最多20项；保留 Pi 隐藏项、忽略规则、符号链接、相对/绝对/`../`/`~/` 路径和引号语义。搜索使用已有 `fd`/`fdfind`；缺失时返回 `input-unavailable`，不在查询中下载。未加载会话从 SessionManager 读取 cwd，不创建 SDK 会话或初始化模型。
- `insertText` 仅替换 `prefix`；文件带尾空格、目录继续补全。`cursorOffset` 是替换文本内 UTF-16 光标位置，带引号目录停在闭引号前。`consumeClosingQuote=true` 且原光标后首字符为闭双引号时吞掉该字符，避免重复闭引号；其他前后文字、选区和中文组合输入由手机保持。
- `path` 用于同名路径区分；只返回路径元数据，不读取内容、不自动转附件，不走启动参数 `pi @file` 的全文读取。
- 每连接每种查询只保留最新请求；新查询、空 token 和断连取消旧 fd。旧结果及旧错误不发送；3秒期限后发送关联 `input-timeout` 并取消搜索。两种查询分开取消。客户端仍须按查询 ID、会话/cwd 和当前编辑片段丢弃迟到帧；清空输入、切会话、重连和重载后刷新。
- 旧 `commands` 帧语义不变；新客户端先探测 capability，没有能力时不发送远端候选请求。

### 4.26 `entry-copy` — 整条 entry 的可复制全文

```json
{"type":"entry-copy","sessionId":"<uuid>","entryId":"<entryId>"}
→ {"kind":"entry-copy","sessionId":"…","entryId":"…","bytes":1234,"text":"…全文…"}
```

- 对齐 Pi TUI 树选择器的 Ctrl+X（`app.message.copy` → `TreeList.getEntryCopyText`）：**当前选中 entry 的完整可复制文本**，不是树行的 120 字 `preview`、不是 200 字搜索窗口，也不是整条分支。
- 文本口径逐类型对齐 SDK 1.3.0：`message`+`bashExecution` 取 `command`；其余 `message` 拼接全部 text 块（assistant 无正文时回落 `errorMessage`）；`custom_message` 取正文；`compaction`/`branch_summary` 取 `summary`。返回未 trim 的原文。
- 其余类型（`label`、`model_change`、`thinking_level_change`、`session_info`、`context_edit`、`usage` 等）以及 trim 后为空的内容 **没有可复制文本**：回 `entry-copy-empty` 错误帧，网关不造占位文本、不退回 `preview`。
- 只读端点：live 句柄优先，未加载时回落文件视图（文件头 `id` 是权威身份，陈旧索引解析到别的会话文件按 `session-not-found` 处理），与 §4.22 attachment 同一查找路径。
- **超限不截断**：文本 UTF-8 字节 > 512 KiB（`ENTRY_COPY_MAX_BYTES`，与 §4.5 单消息预算同量级）时不带 `text`，只回 `{"oversized":true,"bytes":N}`。客户端必须明确报“内容过大未复制”，不能把节选当全文粘给用户。
- 错误：`sessionId`/`entryId` 缺失或超过 256 字符 → `bad-request`；未知会话 → `session-not-found`；未知 entry → `entry-not-found`；无可复制文本 → `entry-copy-empty`。错误帧在**参数齐备时**回显 `sessionId`+`entryId`（与 attachment 同口径；缺参帧本身没有可回显的目标，只带 `requestType`），内部异常只回固定 `internal` 文案，细节进网关日志。

### 4.27 `label-put` — 标签写（新增 / 修改 / 清空）

```json
{"type":"label-put","sessionId":"<uuid>","entryId":"<entryId>","label":"交付"}
→ {"kind":"label-put","sessionId":"…","entryId":"…","label":"交付","labelEntryId":"<新LabelEntry id>","leafId":"<写入后的运行时叶子>"}
```

- 对齐 Pi TUI 的 Shift+L → `sessionManager.appendLabelChange(targetId, label)`：追加一条 `label` 类型的 `LabelEntry`，**`targetId` 指向被选中的 entry**，旧消息不改写；同一 target 多次追加时最后一条记录生效（`labelsById` 覆盖语义）。
- `label` 缺席、`null` 或 trim 后为空串 = **清除标签**（Pi `LabelInput`：空值提交 `undefined`），应答里 `label` 为 `null`。非字符串或超过 200 字符 → `bad-request`（Pi 自身不限长，这里是 wire 护栏，不静默截断成另一个标签）。
- **叶子会前进**：新 `LabelEntry` 以当前运行时叶子为父并成为新叶子（Pi 同一行为；标签条目不参与模型上下文，`default` 等筛选下也不显示）。网关写入后同步内部手动叶子钉子，`tree`/`history` 的活跃链以新叶子为起点；否则“显示的当前行”与“跳转目标”会错位。应答带 `leafId` 供客户端核对，客户端随后重拉 `tree`。若 SDK 随后自然追加消息/压缩条目，钉子只跟随原叶子的运行时后代，句柄回收前同步，避免截断后续回答。
- 由此，在 `all` 筛选下重拉 `tree` 时 `leafId`/`selectedId` 会落在新 `LabelEntry` 行上（该类型仅在 `default`/`no-tools` 被隐藏）——这与 Pi 原生 `/tree` 一致（`currentLeafId` 同样指向标签条目）。客户端应以**浏览选中**为动作目标，不得把网关 `selectedId` 直接当默认跳转目标；对 `LabelEntry` 行跳转等价于 `alreadyAt`。
- 写入必须在 **live 句柄**上进行（与 `switch-branch` 同口径）：另开一个文件视图 `SessionManager` 追加会与运行时叶子分叉。因此客户端需先 `subscribe` 打开会话；无活动句柄 → `session-not-found`，网关不隐式 `openSession`。
- 流式/压缩进行中不额外拒绝（Pi 也允许在树选择器里改标签）；标签追加是同步写入，不与运行中的消息重排。
- 错误：`sessionId`/`entryId` 缺失或超过 256 字符、`label` 非法 → `bad-request`；未知会话或无活动句柄 → `session-not-found`；目标 entry 不在该会话 → `entry-not-found`。错误帧在参数齐备时回显 `sessionId`+`entryId`（缺参帧只带 `requestType`）。
- 能力宣告：`tree-actions-v1`（同时含 `entry-copy`/`label-put` 两个帧类型）。旧网关不宣告时客户端隐藏复制/标签入口，只保留浏览选中与跳转。

### 4.28 worktree-v1（工作区）

能力 `worktree-v1` 同时宣告 `worktree-list`、`worktree-create`、`worktree-continue`、`worktree-status`、`worktree-trust`。客户端仅在显式宣告时显示入口。

- `worktree-list {queryId,cwd? ,sessionId?}`：两种位置互斥；会话位置由网关读取真实 cwd。回 `{kind:"worktree-list",queryId,sessionId?,cwd,repoRoot,branch,suggestDir,dirty,worktrees:[{path,branch,commit,main,missing}]}`。非 Git 返回 `repoRoot:null` 与空列表，继续普通目录交互。每次打开及手动刷新重扫，不轮询。
- `worktree-create {operationId,cwd,branch,base,targetPath}`：基点先解析为提交，使用 Git 参数数组创建新分支与 worktree，不执行 shell、不提交/stash/复制未提交文件。默认基点 `HEAD`，默认目录为仓库父目录的 `.worktrees/<仓库名>/<分支名slug>`，最终路径提交前可编辑。 仓库没有任何可达提交时返回 `worktree-no-commits`；不自动创建初始提交。
- `worktree-trust {operationId,targetPath,trustProject?}`：检查目标项目资源的 Pi 信任记录；未信任返回 `worktree-trust-required`。手机明确确认后传 `trustProject:true`，通过公开 `ProjectTrustStore` 只信任该规范路径，返回 `{kind:"worktree-trust",operationId,cwd}`。首页选目标和在目标新建会话也先检查。
- `worktree-continue {operationId,sessionId,targetPath,trustProject?,retry?}`：源会话必须空闲、无压缩和待发队列；目标可为 worktree 根或普通目录。通过 Pi 公开会话 API 保留完整树、当前活动分支和模型/思考，在目标目录建立独立运行器；源会话保持可用。失败不切客户端会话，不隐式终止任务，不更改首页目标。
- 两种写操作回 `{kind:"worktree-operation",operationId,action:"create"|"continue",status:"pending"|"succeeded"|"failed"|"unknown",sessionId?,targetSessionId?,cwd?,code?,worktree?}`；`sessionId` 为源会话，成功继续的目标 ID 为 `targetSessionId`。创建与继续是两次独立操作，创建成功后继续失败时不能再次创建。
- `worktree-status {operationId}` 查询同次结果，响应同上。标识是客户端随机 UUID；参数相同的重复提交共享同一结果，参数不同拒绝 `worktree-operation-conflict`。仅已明确失败的继续允许 `retry:true`；复用同一目标会话文件，不再次fork。结果写入宿主私有操作记录，连接断开不取消服务端操作。进程重启后，已完整落盘的会话副本可由同次标识恢复；其他未记录最终结果的操作返回 `unknown`，不重放写操作；客户端保持待确认并允许再次查询，不能当失败重新复制会话。
- 拒绝错误帧携带 `queryId` 或 `operationId`。错误只给稳定码与短文案，不回显 Git/OS 原始 stderr。可用码：`worktree-not-git`、`worktree-target-unavailable`、`worktree-branch-invalid`、`worktree-base-invalid`、`worktree-no-commits`、`worktree-path-invalid`、`worktree-path-exists`、`worktree-create-failed`、`worktree-busy`、`worktree-queued`、`worktree-model-unavailable`、`worktree-continue-failed`、`worktree-result-unknown`、`worktree-operation-not-found`、`worktree-operation-conflict`、`worktree-operation-invalid`、`worktree-git-failed`、`worktree-source-changed`、`worktree-trust-required`。

首页选择只设置新会话目录；会话内“新建会话”回首页，首条消息才创建；会话内“继续”才调用继续端点。客户端在权威成功后同时更新订阅、历史、目录与草稿归属，失败或未知不清源草稿。旧网关的其他功能保持原协议。

## 5. 管理面（localhost HTTP，不面向移动端）

| 方法与路径 | 说明 |
| --- | --- |
| `GET /mgw/status` | `{dataPort, publicUrl, devices:[...]}` |
| `POST /mgw/pair` | body `{"name"?, "publicUrl"?}` → `201 {pairingText, payload}` |
| `GET /mgw/devices` | `{devices:[{id,name,createdAt,lastSeenAt,online,connections}]}` |
| `POST /mgw/devices/:id/revoke` | 吊销设备（token 立即失效，在线连接以 `4003` 关闭） |

管理面是签发配对码、查看/吊销设备的运维入口，只绑定 `127.0.0.1`；移动端**不得**调用管理面。它是单用户个人部署的假设面：宿主机上的其他本地进程/账户同样可以访问它，没有用户隔离。

防护（针对浏览器攻击面）：

- `Host` 必须是 `127.0.0.1[:port]` / `localhost[:port]` / `[::1][:port]`，否则 `403`（DNS rebinding 防护）；
- 携带 `Origin` 且与 `Host` 不同源 → `403`（CSRF 防护）；
- `POST` 必须 `Content-Type: application/json`，否则 `415`（阻断跨域"简单请求"）；
- `publicUrl` 在签发前校验：必须 `ws://`/`wss://`（`http(s)://` 自动升级）、不得内嵌凭据/query/fragment、`ws://` 仅限回环与私网地址（含 100.64.0.0/10），否则 `400`；
- body 超过 64 KiB → `413`；无效 JSON / 非 JSON 对象 → `400`。

数据面帧上限 18 MiB（超限 close `1009`）；管理面 body 上限 64 KiB。

### r21 兼容扩展（2026-10-07）

- `ping-id`：ping 可带最长128字符 `pingId`，pong 原样回显；客户端按同一请求的单调时钟计算往返耗时。缺省保持旧pong。
- `provider-catalog-v1`：providers 响应新增独立可选 `catalogProviders`（`id/source="models-store"/readOnly=true/models`）；模型只含 `id/name/contextWindow/maxTokens` 白名单，不含地址、headers、凭据或raw配置。来源是 SDK 的 `models-store.json`，只读，不进入 provider-put/delete。`catalogError` 为可选公开错误，缓存读失败不遮蔽可编辑的 models.json 列表。缓存文件可能原地写；两次一致可解析快照及三次有限重试，不把格式错误写成空数据。
- `history-turns-v1`：history 可指定 `turnLimit`（1..10），优先于旧的原始entry `limit`。一轮从真实user消息开始，包括工具交互，直到最终assistant（stopReason非toolUse）；连续steer输入在最终输出前仍属同轮。终止/error/aborted以终态结尾；最新未完轮仍随最近窗口显示。元数据及branch_summary不新开轮。先取最近最多10轮，older沿原有排他beforeEntryId游标分页；只整轮裁减2MiB预算，单轮超限明确失败，不悄悄截断轮。旧limit语义不变。

### r25 兼容扩展（2026-10-08）

- `provider-model-base-url-v1`：Provider 每模型可读写独立地址，编辑/草稿测试按 §4.17 的省略/覆盖/继承语义。旧网关不宣告时客户端不显示编辑、不下发字段。
- `model-scope-v1`：全局显式保存范围，宣告请求 `model-scope` / `model-scope-put`，契约见 §4.23；临时/项目范围不在此首版。

### tree-actions-v1 兼容扩展（2026-10-15）

- `tree-actions-v1`：树页动作接线，宣告请求 `entry-copy`（§4.26）/ `label-put`（§4.27）。两端点对应 Pi TUI 树选择器的 Ctrl+X 与 Shift+L，只覆盖这两个操作：不扩展时间快捷键、消息编辑/删除、筛选循环或其他维护命令。
- 客户端只在发现 `tree-actions-v1` 后才发送这两类请求；旧网关上动作卡只显示“跳到此处”，复制/标签入口隐藏并提示升级网关。发布新 APK 不代表网关服务已更新。
- `tree` / `switch-branch` / `tree-view-v1` 的既有语义不变；标签写会推进叶子这一点由 §4.27 明确，客户端不得把新 `LabelEntry` 当可见行或跳转目标。
