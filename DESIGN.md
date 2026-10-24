# pi-mobile-gateway 设计

## 目标

- 手机通过设备鉴权 WebSocket 使用本机 pi：实时对话、工具与思考过程、会话管理。
- 安全默认值与 dsh-plugin-mobile-gateway 对齐：一次性配对码、哈希存储 token、localhost 管理面。
- 独立 Node 进程，不是 pi 扩展：网关生命周期独立于任何 pi 会话。

## 非目标

- 不做 pi TUI 内嵌界面（TUI 伴生扩展是独立仓库，另行单独开发）。
- 不做多用户/多租户：单用户个人设备，设备数按需吊销。
- 不自带 TLS 终止：公网由 Nginx/Caddy 等反向代理提供 `wss://`。
- 不提供独立凭据代理；Provider 编辑通过 Pi 配置接口写入宿主 `models.json`，设备注册表不保存模型 API Key。
- 不实现 dsh 网关的"5 分钟自动关闭"：那是"插件常驻 web 服务器"背景下的设计；独立进程的启停本身就是开关。

## 为什么不是 pi 扩展（决策记录）

dsh 的网关做成插件，是因为 `dsh web` 本身常驻 Web 服务器，插件可挂载 `ctx.webServer` 与 `ctx.apiProxy`。pi 的对应形态是：

- pi 扩展契约禁止 factory 启动常驻 socket/子进程；资源生命周期绑定 session（`session_start`/`session_shutdown`），TUI 退出即消亡，与"多会话网关"矛盾；
- pi 官方 SDK（`createAgentSession` + `SessionManager`）明确支持"build a custom UI (web, desktop, mobile)"用例，pi-web（MIT）已用同一路线验证；
- 故网关为独立进程，进程内通过 SDK 驱动 pi（方式一）；`pi --mode rpc` 子进程（方式二）与实验性 pi-server（方式三）作为后备演进路线。

## 模块与公开 API 映射

| 模块 | 职责 |
| --- | --- |
| `src/devices.ts` | 设备注册表：配对码签发/领取、token 哈希鉴权、在线计数、吊销（含 `onRevoke` 通知）、原子持久化 |
| `src/credentials.ts` | 升级请求凭据提取：Bearer 头 / 子协议 `pi-auth.` / `pi-pair.` / query 配对码回退 |
| `src/pairing.ts` | 配对载荷编解码：严格无 padding Base64URL + JSON + 版本/过期校验 |
| `src/net-guards.ts` | 网络防护：私网/回环判定、管理面 Host 白名单、同源校验、publicUrl 规范化 |
| `src/server.ts` | 数据面：`/ws/mobile` 升级、401/403/400/404 拒绝、吊销踢连接（4003）、`paired`/`hello`（含 capabilities）/`pong`/`error` 帧；业务帧经 `onClient` 注入的每连接处理器分发 |
| `src/wire.ts` | 线协议词汇：pi 事件投影（`toJsonEvent` 语义）、会话条目→消息渲染、活动分支切片、字节上限 |
| `src/pi-runtime.ts` | 会话运行时：共享 ModelRuntime、sessionId→路径索引（listAll + TTL 缓存）、活动句柄注册表（事件 seq/订阅 sink/prompt 受理串行化/空闲回收）、活动分支历史分页（首 assistant 落盘前与流式中的旧会话均补入 live 尾部条目，前缀不成立时视为陈旧不并入） |
| `src/router.ts` | 业务帧分发：每连接订阅表、参数校验、`sent`/`history`/`state`/`subscribed` 等应答与统一 error 帧 |
| `src/input-assist.ts` | Skills/Prompt 会话清单及不安装包的本地预览；复用 Pi TUI 公开 @ 补全，每连接取消旧 fd、超时及响应归属 |
| `src/extension-status.ts` | 扩展 UI 只读桥：`ctx.ui.setStatus` → 会话级状态行（去 ANSI、长度/行数护栏），其余 UI 方法 no-op |
| `src/mgmt.ts` | 管理面：localhost-only JSON API（Host/Origin/Content-Type 防护） |
| `src/main.ts` | CLI 入口、局域网 IP 推断、终端二维码、`--session-dir` 会话目录覆盖 |

## 数据口径

已有会话以已加载的 SDK 资源为准；首页只提供带 `complete:false` 的本地预览，内存配置去掉 Package 源且不运行扩展，避免查询隐式安装或执行代码。会话建立后重新查询完整清单。`@` 只返回路径和编辑片段，不读全文；执行 Skill/Prompt 保持 `session.prompt()` 原文链路。协议、能力通告及取消规则见 PROTOCOL §4.24–4.25。

- 协议版本：`1`（`hello.protocol`）。
- 子协议：`pi-mobile-v1`；配对 `pi-pair.<code>`；token `pi-auth.<token>`；安装头 `X-Pi-Device-ID`。
- 长期 token 与 QR/文本秘密为 256-bit、43 字符无 padding Base64URL；六位数字短码只在首次配对子协议/query 中接受，不作为长期 token。
- 设备注册表 JSON `{version:1, devices:[...]}`，存 `~/.config/pi-mobile-gateway/devices.json`（0600）。token 明文只在内存与网络中出现一次。
- 配对载荷 `{version:1, publicUrl, pairingCode, expiresAt}`，编码为唯一规范 wire 表示（Base64URL 文本）。

## 状态与生命周期

- 网关进程：SIGINT/SIGTERM → 关闭两监听面与全部 WS 连接 → 退出。
- 配对码：长码内存 Map，加一个关联长码的短码窗口（2 分钟、共享 5 次失败预算，新签发替换旧短码）；任一领取成功同时消费长短码。短码到期仍保留长码原期限，失败耗尽则同时作废。只存摘要，签发/领取时修剪，重启全部失效。短码提高输入便利性，不能替代私网隔离，失败预算也可能被恶意耗尽。
- 设备连接：upgrade 成功时 `connected()`（在线计数 +1、lastSeen 持久化），socket close 时 `disconnected()`（计数 -1，幂等）。
- 测试注入：`createRegistry(file, { now })` 注入时钟；监听面用 `port: 0` 走临时端口。

## 测试

- `tests/devices.test.ts`：配对码单次性/TTL、token 轮换、吊销、持久化往返、注册表不落明文、在线计数。
- `tests/credentials.test.ts`：三种凭据来源的提取与拒绝（含"token 不进 query"）。
- `tests/pairing.test.ts`：编解码往返、拒绝 padding/标准 base64/裸 JSON/过期/版本不符。
- `tests/net-guards.test.ts`：私网判定、Host 白名单、同源校验、publicUrl 规范化。
- `tests/server.test.ts`：WebSocket 握手集成——401/403/404/400、paired→hello、token 重连、重放拒绝、过期配对码、query 配对路径、吊销在线连接 close 4003、超限帧 close 1009、畸形请求行不崩进程、管理面 CRUD/413/415/跨域 403/Host 403/publicUrl 校验。
- `tests/wire.test.ts`：事件投影（partial 剥离/id 提升/agent_end 裁剪/turn 省略）、工具调用归一、条目→消息渲染、活动分支切片与游标分页、字节上限、文件设置推导。
- `tests/pi-runtime.test.ts`：脚本化 FakeSession 注入——列表/running 标记、订阅转发与 seq、prompt 受理与串行化、历史分页、状态推导、新建会话、abort、空闲回收与虚拟时钟。
- `tests/router.test.ts`：真实 WS 端到端——sessions/history/state/subscribe/unsubscribe/abort/未知命令、message 校验矩阵、prompt-rejected、断线退订、事件投影在线上帧的形状。
- 手工 smoke：CLI `--pair` 打印二维码；`node scripts/smoke-verify.mjs` 全链路（配对→重连→心跳→重放拒绝→吊销踢连接→畸形请求存活 + 会话业务帧；`--prompt` 附加一条真实消息的端到端）。

## 网络与异常处理约束

1. 畸形请求行（绝对形式 URL + 非法 IPv6 字面量）使 `new URL()` 抛异常逃逸 upgrade handler，未鉴权单包崩溃进程 → upgrade 顶层 try/catch + `reject(400)`。
2. 吊销不关闭在线连接（dsh 原版 close 4003 语义丢失）→ registry 增加 `onRevoke` 通知，数据面按设备追踪连接并 close(4003, 'device revoked')。
3. 管理面丢失原版跨域防护 → Host 白名单 + `isSameOrigin` + POST 强制 `application/json`（415）。
4. 数据面丢失私网来源限制 → 移植 `isPrivateNetworkHostname`，非私网来源 403。私网判定含 RFC1918、RFC6598 CGNAT 100.64.0.0/10（Tailscale 等 mesh VPN 的节点地址，tailnet 不可公网路由，明文 `ws://` 威胁模型与 RFC1918 相同；注意 RFC6598 属"共享地址空间"，非 mesh VPN 场景下运营商 CGNAT 网内为订户共享语义，风险接受以 tailnet 的 WireGuard 点对点加密为前提）与 IPv6 ULA/链路本地。
5. **ws 库在协议级错误（超限帧）时会 `emit('error')`，服务端连接未挂 error 监听器则 uncaught exception** → 数据面为每个连接挂 error 吞掉（ws 已自行发起 close 1009）。
6. 无效 JSON 400、超限 body 413、500 不回显内部信息、`/mgw/pair` publicUrl 签发前校验、CLI 启动失败友好报错、无可用地址拒绝生成二维码、删除 `revokedAt` 死字段。

## Pi SDK 接入决策

### 决策一：事件词汇 = pi 原生 + pi 自家 JSON 投影（原「直接映射」的落地形式）

- **选择**：`event` 帧的 `event` 字段直接承载 pi `AgentSessionEvent`，按 pi 官方 RPC stdout 协议的 JSON 投影语义裁剪（`message_update` 去累积快照 `partial`、`toolcall_start/delta` 提升 `id`/`toolName`）；另做 pi-web 同款的两处带宽裁剪：`turn_start`/`turn_end` 不下发（回合边界由消息序列隐式表达）、`agent_end.messages` 丢弃（每条消息已由 `message_end` 权威送达）。
- **否决项**：dsh 风格二次包装（`GatewayEvent{text,tool,turn,…}`）——fork 端要反向还原 pi 语义，两头维护；以及裸透传 SDK 原始事件——`partial`/`messages` 让移动端帧体积不可控。
- `toJsonEvent` 本身不是包的公开导出（类型 `JsonAgentSessionEvent` 是），故按 pi-web（MIT）的实现等语义自写投影，公开类型约束输出形状。

### 决策二：历史分页 = 文件条目 + 条目 id 游标（原「pi-web session-reader 路线」）

- **选择**：每次读会话 JSONL（`SessionManager.open` → `getEntries()`），沿活动分支从叶向根迭代切片（防深会话递归爆栈），再过 SDK 公开的 `buildContextEntries()` 做压缩感知，最后渲染成消息 + 平行 `entryIds`。分页游标 `beforeEntryId`（互斥），字节上限 2 MiB 保最新后缀（dsh 的 `capHistoryEvents` 语义）。
- **否决项**：`SessionManager` 内存快照路线——历史必须能服务"句柄已被空闲回收"的会话，且文件即真相，避免双读路径。
- 部分切片穿越压缩窗口时 `buildContextEntries` 优雅降级（摘要后的条目仍完整），与 pi-web 分页行为一致。

### 决策三：`message` 三态映射到单一 `prompt()` 入口

- `mode: "prompt"|"steer"|"followUp"` 全部走 `session.prompt(text, {streamingBehavior})`：`prompt()` 在空闲时立即执行、流式时按 `streamingBehavior` 排队——一个调用点覆盖三态，pi 自己处理状态机；
- 主动停止与 Pi TUI Esc 对齐需要两步：公开 `clearQueue()` 取回尚未消费的文本，再 `abort()` 等待 idle；SDK 的 abort 本身不清队列。新客户端以 `restoreQueued:true` 显式选择，网关在同会话 admission 串行区执行，通过 `aborted.queued` 返回文本、状态快照返回清理后的队列；客户端不凭旧快照假清或自动重发。省略该字段时保留旧客户端只停止语义；文本以外附件及断线丢失取回回执不在 SDK/现协议保证范围内。
- 不打断输出的取回使用独立`dequeue`：同会话admission内调用公开clearQueue，取回当时未消费的两类队列并在同步段发送匹配queueRequestId的回执，避免之后的settled先于旧快照到达；不abort、不重新入队。手机只在能力存在时显示整批取回入口，并保留当前运行的保活计数。SDK没有逐项撤回和排队图片返回接口。
- 流式且未带 mode → SDK 抛错 → `prompt-rejected` 错误帧（pi RPC 同语义，不猜默认）；
- 应答时机 = pi preflight 受理（`preflightResult(true)`），非运行完成——受理后失败走事件流；prompt 受理做了串行化（pi-web 的 admission queue），并发发送时第二条能看到第一条的流式状态；
- `sent` 响应前先给发送连接挂上事件订阅，首批事件不可能先于订阅。

### 决策四：会话句柄生命周期

- 内存句柄 = SDK `AgentSession` + 每会话事件 `seq` + 订阅 sink 集合 + 受理队列；按需加载（订阅/发消息时），空闲且无订阅者 5 分钟由清扫器释放；**运行中/压缩中的句柄永不回收**——手机断线，pi 跑完整个 run；
- `dispose()` 走 SDK `dispose()`；网关进程退出时全部释放；
- 列表索引走 `SessionManager.listAll()` + 15s TTL；并发扫描共享同一失效代的promise，旧代结果不能回写新索引。打开已知会话可复用经文件存在和头ID核实的路径，正文仍按文件stat刷新，路径删除/身份变化重查；新建会话即失效。`sessionDir`覆盖贯穿create/open/listAll，测试用临时目录隔离。

### 决策五：扩展绑定 = `bindExtensions({mode:"rpc"})` + 只读 uiContext（仅状态行）

- 与 pi 自家 RPC 模式同款绑定；网关传入自己的 `uiContext`，但只实现 Pi 公开的 `ctx.ui.setStatus(key, text)`，映射为会话级 `extension-status` 快照帧（PROTOCOL §4.29）。`setWidget`/`notify`/对话框等其余方法保持 no-op（对话框立即返回取消），避免没有完整 UI 协议时让扩展等待；
- 动机：桌面 TUI 的子 agent、压缩、后台任务等扩展会通过 `setStatus` 发布“正在运行”的状态行；桥接这个公开原语后，手机无需逐个适配扩展包，任何遵循 Pi 扩展 UI 契约的实现都能显示状态。pi-subagents 等扩展在 RPC 模式补发 `setStatus` 即可；
- 边界：状态是显示提示，不证明任务终态、不参与会话保活/回收，也不能替代结构化后台任务协议；完整对话框/通知/widget 交互仍需要单独设计请求、应答与取消流程，不能由普通工具事件推断；
- 生命周期：`uiContext` 与 SDK 句柄同生共死；`subscribe`/`restart-session` 应答携带快照，`session.dispose()` 时随句柄丢弃。扩展加载/绑定失败仅记录，不致命；
- 初始化与重载：句柄登记后仍有 `ready` 门禁，扩展绑定完成前 `openSession`/`state`/`prompt` 等入口等待，sweeper 与容量淘汰跳过初始化中的句柄；同会话 `restart-session` 串行执行，迁移订阅者后无条件广播一份完整状态快照（新扩展可能在 `session_start` 就发布状态）。

### 决策六：并发构建去重

- `openSession`/`createSession` 维护 in-flight Promise 表（pi-web `rpc-manager.ts` 的 startLocks 同款）：并发加载同一会话 / 同 cwd 并发新建**共享一次工厂构建**；
- 动机：两路并发构建会各自 `createAgentSession`，被覆盖的第一个实例成为孤儿（永不 dispose、清扫器不可见），挂到孤儿上的订阅者收不到后续 run 的事件；
- `buildSession` 另有幂等护栏：工厂运行期间若同 id 的存活句柄已注册，丢弃新实例复用旧句柄（公开接口在锁之后不可达，纵深防御）。

### 决策七：出站体积预算

- 预算常量：实时事件帧 1 MiB（与入站帧上限对称）、历史单条消息 512 KiB（必须低于 2 MiB 页上限）；
- 策略 = 先测量、超限才降损（`shrinkForWire`）：图片 base64 → `{dataOmitted, dataBytes}` 元数据占位（小图不受影响，完整历史图片通过独立 `attachment` 请求按需取回）、超 10 万字符的字符串截断加 `[已截断]` 尾标；
- 仍超限的兜底：事件帧 → `event_omitted` 存根（seq 照常推进，客户端用 history 对账）；历史消息 → `wire-oversized` 存根。由此 **2 MiB 页上限恒成立**（单条超大消息不再能击穿分页契约）；
- 不采用对所有大字段统一延后拉取的路线；历史图片有独立 `attachment` API，超大文本仍遵守出站预算。
- 成本注记：每个事件帧在投影后多一次 JSON 序列化用于测长（发送时还有一次），个人使用量级可接受。

### 决策八：错误卫生与容量上限

- `internal` 错误帧的 `message` 恒为 `"internal error"`；原始错误（可能含文件路径）只进网关日志（router 挂 `log` 回调，main.ts 前缀 `[router]`）——session-not-found / bad-request / prompt-rejected 保持 client-facing 文案；
- 会话句柄数上限 16（`maxLoadedSessions` 可调）：超限淘汰最旧的无订阅者空闲句柄，运行中/有订阅者的永不淘汰；
- 已记录边界：历史读取为同步文件解析（`SessionManager.open + getEntries` 在事件循环上，单文件 MB 级为个人使用量级可接受），如需优化大文件解析，应另评估 worker 化。

### 测试与注入

- `sessionFactory` 可注入：单测用脚本化 FakeSession（accept/emit/abort 可编程），不加载真实 pi 资源、不碰真实 `~/.pi`、不调真实模型；
- `sessionDir` 可注入：历史/索引测试用临时目录手工构造 JSONL；
- 时钟可注入（`now`），空闲回收测试推进虚拟时钟；
- 真实链路由 `scripts/smoke-verify.mjs` 覆盖：`--prompt` 可选发一条真实消息（新会话 + 事件流 + 落盘后 history 回读），默认只读不产生模型调用。

## 会话树

### Pi 会话树展示（tree-view-v1）

新客户端把搜索、过滤模式和折叠ID作为一次树快照的参数交给网关。网关复刻所锁定SDK的可见树投影，返回平铺行、Pi前缀和正文；客户端只负责横向/纵向浏览、焦点与触控，不根据parentId再次计算深度。此接口保留全部匹配节点，客户端使用惰性列表；旧无view请求继续保留400条窗口和旧正文形状。普通消息搜索使用SDK的200字符窗口，不将它描述为全文索引。树快照仅提供浏览数据；显式跳转才走switch-branch，点击行本身不触发导航。

### 树页动作（tree-actions-v1）

手机端树页采用“点行只浏览选中并弹动作卡”，复制/标签/跳转三个动作分别接线：

- **跳转**仍走既有 `switch-branch`，语义不变（`summarize:false`、排队取回、user 节点返回 editorText；assistant 节点仅导航，不回填其正文）；取消动作卡不产生任何导航。
- **复制**用新 `entry-copy`（§4.26）：文本口径逐类型对齐 SDK 1.3.0 的 `TreeList.getEntryCopyText`（TUI Ctrl+X），取整条 entry 的全文而不是 120 字 `preview`；没有可复制文本的簿记条目回 `entry-copy-empty`，超 512 KiB 只回 `oversized`+`bytes`，两端都不静默截断成“全文”。只读，因此允许文件视图回落（与 `attachment` 同一查找路径）。
- **标签**用新 `label-put`（§4.27）：对齐 Shift+L 的 `appendLabelChange(targetId, label)`——只追加 `LabelEntry`、`targetId` 指向被选中条目、同一 target 最后一条记录生效、空值即清除。追加会推进运行时叶子，网关写完同步内部手动叶子钉子，`tree` 的 `leafId`/`selectedId` 因此不会把隐藏的标签条目当成当前行或跳转目标。写入必须在 live 句柄上（另开文件视图 `SessionManager` 追加会与运行时叶子分叉），无活动句柄回 `session-not-found`。
- 范围只覆盖这两个操作：不扩展时间快捷键、消息编辑/删除、筛选循环或其他维护命令；标签长度上限 200 字符是 wire 护栏（Pi 自身只 trim 不限长），手机端输入框另限 24 字符。
- 旧网关不宣告 `tree-actions-v1` 时，客户端隐藏复制/标签入口，只保留浏览选中与跳转。

## Provider 来源与历史窗口

Provider按来源分开：可编辑配置仍由PiProviderStore管理models.json，SDK生成的models-store.json独立白名单只读，不把缓存项拼进provider-put。两次稳定读取与有限重试容忍SDK原地写缓存；格式错误单独报告，配置列表仍可见。模型菜单以Pi getAvailable与enabledModels为准，连接测试状态不再额外隐藏模型。

history-turns-v1保留旧entry分页兼容。活动分支上的真实user到最终assistant为一轮，steer在轮内，工具调用不切轮，未完轮仍显示。请求最多10轮，预算仅按整轮缩页；单轮超限返回 history-turn-too-large，当前手机端收到关联错误后改用条目游标分页，并保留继续向前加载入口，不循环重试整轮请求。手机端仅用户向旧记录滚动时分页，latest刷新有可证明条目重叠时保留较旧前缀及原游标，无重叠不猜接历史。

`provider-test` 通过一次有界的非流式生成请求验证基础连通，只有协议内的实际模型输出才算通过；不认证完整流式或工具等能力。 每次探针使用独立请求标识关联终态，防止超时重试被迟到的旧成功误认证；未具备关联能力的网关由新版客户端提示升级。返回稳定诊断码、短文案、HTTP 状态与耗时，不回显原始上游错误或地址。测试不自动写配置；手机按连接改动决定是否要求测试，`provider-put` 独立执行格式校验与合并，不以聚合诊断决定保存或启用模型。

## 模型范围与历史读取

模型定义与菜单范围分别管理。菜单默认解析Pi全局settings.json的enabledModels，不把网关工程项目设置当用户全局scope；Provider保存不自动追加provider/*。空或全部无匹配scope按Pi默认回到可用目录，部分无匹配项省略。恢复已有会话传scope但不覆盖记录中的模型和思考档位；不提供/model的all切换、项目scope编辑或/scoped-models临时编辑。Provider模型调序属于手机视图和探针测试次序，不改变宿主配置的模型顺序。

已知路径复用与并发索引合并只减少目录扫描，不长期缓存正文，也不改变10轮、活跃分支、实时尾及预算语义。阶段耗时日志只包含耗时与条目数。合成测量只说明网关读取耗时，手机端到端延迟仍需在真实网络和设备上验证。

## 两级模型地址与全局范围编辑

模型有效地址遵循Pi的 model.baseUrl > provider.baseUrl。地址读出不含凭据；手机未编辑省略字段保留旧覆盖，显式null删除覆盖恢复继承，字符串原样覆盖。草稿探针的独立modelBaseUrl带相同三态，不把公共地址误当模型覆盖，不自动裁加/v1。已存诊断只认证与探测配置一致的当前模型。

模型范围编辑单独读取全部可用目录及全局patterns，通过公开SDK resolver展开勾选并保留原思考级别。只有显式保存写具体provider/model[:level]，既有无匹配条目单列、默认保留；不新增通配符。恢复默认写空数组以沿用Pi全量目录语义。保存串入settings写队列，并核对读取快照、flush/reload确认落盘，其他settings字段保持；前后发现配置变化拒绝或报告未确认，不宣称跨进程原子锁。保存不会调用setModel；项目或会话临时scope未迁移。应答及错误回显scopeRequestId，手机只接受自己的在途终态；超时/断连保留草稿并要求重读确认。

## 通用 Pi 契约与插件边界

message回执补充SDK输入处置及受理后状态；handled不等于运行结束，不合成agent_settled。客户端分开记录待回执输入和实际运行。普通工具按调用ID处理，嵌套调用保留父ID并消费end，不按Agent名称判断后台任务生命周期。

历史消息新增entryType区分Pi原生压缩、custom_message和网关超限占位；私有custom内部条目不进消息历史，可见custom_message仅作通用文本显示并尊重display。删除empty-stop-retry专用投影；不读取插件私有状态，不复制TUI面板。custom消息的live身份仅按同批SDK追加事件与条目的一一顺序绑定；异常/歧义时不按内容或时间猜ID。

### 手动压缩的调用占用

`compact()`先等待当前回答停止，SDK的`isCompacting`在此之前仍为false。网关以句柄上的在途调用覆盖这一启动窗口，合并同会话重复触发，并将该占用计入state、运行状态及回收/重启门控。收尾先排空Pi事件，再推送独立compact-finished通知及最终状态；不新增压缩接口、不伪造Pi生命周期事件，手机不按固定秒数推断可以重试。

## 工作目录与 Git worktree

`worktree-v1` 区分首页选择、在目标新建和带当前对话继续。Git 列表与创建调用参数化命令，不执行仓库 hooks；不自动复制未提交文件、stash、提交、合并或删除。目录树浏览不改变已有会话。

继续使用公开 `SessionManager.forkFrom` 保留完整树和 entry ID，再在活动 leaf 后追加真实模型与思考设置，使重开目标仍在同一路径。目标独立加载 cwd 的配置、AGENTS、Skills 和工具，先经原生 `ProjectTrustStore` 确认项目资源；模型或档位无法恢复则拒绝，不静默回落。源运行器保留，快照及目标初始化期间禁止源消息、模型、分支、标签、改名和重载写控制；忙、压缩或仍有队列时不搬对话。

客户端随机 UUID 与宿主私有 journal 绑定同次操作。明确失败可以复用已验证副本重试，断线只查询，不重复 fork；恢复也核对模型与档位。若进程在完整 checkpoint 前中断，仍返回 unknown，不猜成功、不补写或删除副本。手机可以留在源会话继续，迟到结果不再搬动其后编辑；已知目标可从列表打开。第三方扩展的私有内存状态不承诺迁移。协议见 `PROTOCOL.md` §4.28。

## 移动桥接模式（mobile-bridge，2026-10-20）

目标：手机接入电脑上**正在运行**的原生 Pi，而不是只能驱动网关自己新建的 SDK 会话。网关仍是独立 Node 进程；桥接扩展是仓内独立 package `bridge-extension/`，由用户在原生 Pi 里加载，只使用公开 Extension API。 桥接子包由 Pi 原生包管理器登记到全局 `packages`，安装与卸载规则见 [README](README.md#连接电脑上的原生-pi)；网关根包保持独立服务，不声明 `pi.extensions`。

- **拓扑**：Android →（既有鉴权 WebSocket）→ 网关 →（本机 Unix socket，换行分隔 JSON）→ 桥接扩展 → 原生 Pi 会话。手机协议不暴露 socket、运行目录或 IPC schema；`PROTOCOL.md` §4.30–§4.36 是唯一对外契约。
- **模式**：`host-mode` 按宿主持久化（`host-mode.json`，与设备注册表同目录），默认 `sdk`。切换不迁移会话、不搬历史、不 Fork；运行中或有待消费队列、在途写、所有者状态未知时拒绝 `mode-switch-blocked`，避免从手机入口切断已有运行。桥接扩展不常驻、不自动加载，用户不加载时网关保持纯 SDK 行为。
- **后台启动**：网关宣告 `bridge-start` 后，手机可对离线会话请求启动一个带桥接扩展的原生 Pi。网关用真实会话文件在宿主 tmux 中启动，等注册表出现描述符才回结果；按 `operationId` 和 `sessionId` 双重去重，超时回 `launch-result-unknown`，不假装成功。用户用 `pi-mobile attach <sessionId>` 回到该终端。
- **发现**：扩展把描述符写到 `<PI_CODING_AGENT_DIR>/mobile-bridge/registry/`（`PI_MOBILE_BRIDGE_ROOT` 可覆盖），含 `instanceId/epoch/sessionId/pid/socketPath/owner/startedAt`。网关只读注册表 + 检查 pid 存活，不扫描进程表；socket 暂时不可达不算进程死亡。未加载扩展的原生 CLI 不在发现范围内，这是明确的产品边界。
- **单写者**：同一会话只允许一个实例持有 owner 锁（`owners/`）；第二个加载扩展的实例降为只读。只约束加载了扩展的实例，**不宣称全宿主硬锁**：未加载扩展的 CLI 仍可写同一会话。所有写请求都要求 owner，不做最后写入者获胜。
- **身份与去重**：每个请求带 `instanceId/epoch/sessionId`，过期或跨 epoch 一律 `stale-runtime`；`/reload` 或 `/new` 重建 epoch，旧 socket 关闭、新 epoch 重连并重发完整快照。写请求按 `operationId` 去重（同内容重试返回 `duplicate`，内容不同回 `operation-id-conflict`），覆盖手机断线重试。
- **消息语义**：`sendUserMessage()` 返回 void，桥接只回 `submitted`，不伪造 `started/queued` 或完成；终态一律以原生事件和快照为准。忙时未指定 `steer`/`followUp` 回 `busy`（对齐 Pi 原生拒绝）。`model` 预选与从 `cwd` 新建不走 SDK 回退；模型、压缩和树操作通过各自的原生公开接口接入。
- **队列与停止**：`dequeue` 借用公开 `CustomEditor` 的 `app.message.dequeue` 原生动作，整批取回文本；捕获期间 `getText()` 返回空、`setText()` 只记录，电脑草稿保持不变。`abort(restoreQueued:true)` 先取队列再中止，文本交给手机；否则沿用 Pi 原生 Esc 语义把队列还给电脑编辑器。SDK 只提供整批文本取回，不做逐条/排队图片的结构化恢复，也不假装逐项撤回。
- **订阅**：`subscribe` 先回 `subscribed`，再发完整 `bridge-snapshot`，随后转发事件；网关 `event.seq` 仍按连接内会话递增，另带扩展侧 `bridgeSeq` 和 `epoch`。重连/epoch 变化后以最新快照整体替换本地状态。有限重试仍找不到实例才发 `bridge-offline`；收到后降级为只读历史，不自动切回 SDK、不重建会话。
- **离线入口**：原生模式没有在线CLI时，模型候选读取宿主全局可用目录与启用范围；历史Tree与复制只读原会话文件，排除SDK残留手动叶子/句柄。读取不启动Pi。已有会话的明确选模、标签或跳转通过原SID的信任/owner/启动日志激活原生运行器，先发真实快照再按原生接口写；未知写入不自动重发。在线模型查询仍使用CLI实际scope，不用全局候选冒充。契约见 PROTOCOL §4.41。
- **会话列表**：磁盘条目与在线实例按真实 `sessionId` 合并，无在线描述符的磁盘项显式返回 `online:false`，避免首载或重连时客户端保留 unknown 而隐藏后台启动入口；有描述符但快照暂不可读不判离线。在线项带 `source:"bridge"`、`online`、`runtime`、`running`（取快照 `busy`）；只有在线实例没有磁盘文件的条目也返回。`sdk` 模式应答保持旧形状，不新增字段。
- **隔离与测试**：`tests/bridge.test.ts` 用假扩展 socket + 临时注册表覆盖发现、代理、错误码、host-mode、会话合并、订阅转发与写操作；`tests/bridge-launch.test.ts` 覆盖后台启动去重、并发等待、operationId 冲突与超时未知。`bridge-extension/e2e/` 用合成 Provider/工具在独立 tmux 与临时 Pi 配置下跑真实 CLI：中途接入、断线重连保留 partial、dequeue 保留电脑草稿、真实 settle、活动工具停止、回原 CLI 同 runtime、`/reload` 新 epoch、`/new` 新 sessionId；反例（丢 partial、假 abort）必须失败。该 E2E 只证明扩展与本机 IPC，不代表 Android 端、真实网络或真实模型验收。

### 已有原生会话按需续聊

显式发送可通过 `bridge-native-resume-v1` 请求启动原 SID 的后台 Pi；列表与历史读取不触发。路径来自索引或在线描述符，模型由原生 `--session` 恢复，不 Fork、不创建 SDK 句柄。复用 `BridgeWorkspaces` 持久操作日志，将启动与提交分开去重；提交日志只存指纹和结果。启动未知只观察，提交未知只查原实例收据；不能因网络丢回执自动重发。快照先建立实例身份，随后才确认冻结的提交。协议见 [PROTOCOL.md](PROTOCOL.md#440-原生会话按需续聊bridge-native-resume-v1)。

## 桥接终态的持久化边界

Pi 的公开扩展 message_end 早于 SessionManager.appendMessage。桥接扩展先暂存有界 FIFO，在后续公开事件或快照读取时按原 message 引用补真正的 entryId，再按序发出；不能在回调里等待持久化，也不按正文/时间戳猜身份。settled、生命周期和队列上限为无法关联的记录提供保守收尾。常规终态与历史共享条目ID，客户端才可合并同一消息，同时保留合法同文消息。

### 原生模型控制

桥接模型目录与选择以原生 CLI 的公开 ExtensionContext/ExtensionAPI 为真源：会话 scope 和认证目录决定可选模型，setModel 与 setThinkingLevel 决定实际结果。IPC 只投影模型白名单，原生模型事件不原样转发含 headers 的 Model。目录查询绑定 queryId，模型写绑定 operationId，均关联 session/instance/epoch；原生目录不落入 SDK 全局缓存，离线/旧扩展不回落 SDK。切换只影响该会话，不修改全局默认，流式时沿用 Pi 后续请求生效的语义。

### 桥接上下文与压缩

通过公开 `ctx.getContextUsage` 与 `ctx.compact` 接入当前原生运行时，保留其压缩钩子及未知统计。压缩请求沿用实例/代际/操作去重和单写者；回调决定真正终态，busy覆盖启动期。压缩、普通生成分别投影，状态边界携带统计，避免每个文本delta扫描上下文。取消沿用原生abort/队列归还；缺终态不伪造成功。协议见PROTOCOL §4.35。


### 原生树与会话操作

树读取原生 manager 当前内存（含未落盘条目），复制使用共享的 Pi 全文语义，标签和标题由原生公开 API 追加。网关仍负责树展示投影，不另开 SDK 句柄。navigateTree 只在 ExtensionCommandContext 可用，因此桥接注册唯一内部命令，用一次性 nonce 获取新鲜 context，并等待实际完成；void sendUserMessage 不作为完成证明。运行、压缩、有待注入队列时先拒绝导航，保持队列可取回。

Pi TUI 导航会给空编辑器自动回填。手机需要节点稿，但电脑可能正在输入；桥接只在无键盘输入、无额外 setText 且文本仍是本次自动回填时恢复电脑旧稿，不做跨 await 的无条件回滚。操作回执与错误均绑定 operation/session/instance/epoch，避免旧请求污染新代际。协议见 PROTOCOL §4.36。


## 原生输入资源与调用

桥接输入清单读取原生实例公开命令与合并设置，不重新运行 loader 或用网关 SDK 创建第二个会话。查询绑定 query/session/instance/epoch，候选完成时再次核对实例与模式；复用输入辅助的取消和超时。`@` 只用当前实例 cwd 与 Pi 公开补全器，不读取正文。

Skill/Prompt 的正文展开与参数由同一原生 Pi 处理。只为当前存在且没有扩展同名遮蔽的资源开启 expandPromptTemplates，其他扩展命令拒绝，避免把只提供选择与调用的手机入口变成任意 TUI 命令入口。候选存在与 submitted 都不保证实际启动模型；输入处理器仍可按原生语义消费。协议见 PROTOCOL §4.37。


## 原生工作区与新会话

桥接的目录列表与 Git worktree 创建沿用只读/目录级能力，源会话级 Fork 在原生扩展的同步回调中调用公开 SessionManager.forkFrom，保留源运行器与文件；目标叶子与模型/思考设置单独持久化，再通过 tmux 启动目标原生 Pi。目标真实快照校验失败不假称成功。新空会话用 --session-id 指定 ID，避免 --session 指向不存在文件造成随机 ID。目标项目仍需显式信任。

BridgeWorkspaces 使用独立操作日志，记录目标 checkpoint；未知只查询同一目标，查询不走 PiRuntime 的 SDK 恢复。源侧持久 Fork 回执在 reload 后仍防重复，复制窗口不 await。目标目录按网关 sessionDir 配置或目标 cwd 计算存储目录。首条 message 显式 nativeNew，在订阅真实快照后提交，客户端身份不由 sent 建立。SDK 原有路径不作为桥接回退。契约见 PROTOCOL §4.38；隔离真实 Pi 合成验证不替代手机与真实 Provider 验收。


## 原生配置刷新边界

Provider落盘后，手机仅刷新当前在线原生实例。扩展通过公开ModelRegistry.refresh和同名setModel，沿用模型写队列与去重；空闲门槛、刷新前后context/model/thinking校验保护晚到结果，controlPending覆盖未完成模型写。保存与运行时应用分别报告。显式refresh-model使旧扩展能拒绝，不用会被忽略的flag冒充生效。

ctx.scopedModels没有公开setter，刷新目录或/reload不重算scope，因此全局scope保存仅供后续原生启动。原生setStatus没有独立公开getter/事件；获取FooterDataProvider会替换终端footer，不采用。不持有SDK句柄来绕过公开边界。PROTOCOL §4.39为契约。


## 网关与后台原生 Pi 的服务生命周期

BridgeLauncher启动的tmux/Pi继承网关cgroup，脱离终端不等于脱离systemd。可选用户服务采用KillMode=process：重启保留原生实例，停止也保留，用户通过attach结束原生Pi，不做隐式清理或后台监督框架。默认control-group与process已用独立服务、真实Launcher/Pi对照验证，测试服务与所有子进程均独立回收；正常服务不被实验修改。安装与退出见Docs/native-service.md，示例不自动部署。
