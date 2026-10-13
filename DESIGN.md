# pi-mobile-gateway 设计

## 目标

- 手机通过设备鉴权 WebSocket 使用本机 pi：实时对话、轨迹、会话管理（阶段 2 起）。
- 安全默认值与 dsh-plugin-mobile-gateway 对齐：一次性配对码、哈希存储 token、localhost 管理面。
- 独立 Node 进程，不是 pi 扩展：网关生命周期独立于任何 pi 会话。

## 非目标

- 不做 pi TUI 内嵌界面（TUI 伴生扩展是独立仓库，另行单独开发）。
- 不做多用户/多租户：单用户个人设备，设备数按需吊销。
- 不自带 TLS 终止：公网由 Nginx/Caddy 等反向代理提供 `wss://`。
- 不代理 Provider 凭据，不保存任何模型 API Key。
- 阶段 1 不实现 dsh 网关的"5 分钟自动关闭"：那是"插件常驻 web 服务器"背景下的设计；独立进程的启停本身就是开关。

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
| `src/mgmt.ts` | 管理面：localhost-only JSON API（Host/Origin/Content-Type 防护） |
| `src/main.ts` | CLI 入口、局域网 IP 推断、终端二维码、`--session-dir` 会话目录覆盖 |

## 数据口径

输入辅助先实现网关契约，手机候选布局等待负责人原型。已有会话以已加载的 SDK 资源为准；首页只提供带 `complete:false` 的本地预览，内存配置去掉 Package 源且不运行扩展，避免查询隐式安装或执行代码。会话建立后重新查询完整清单。`@` 只返回路径和编辑片段，不读全文；执行 Skill/Prompt 保持 `session.prompt()` 原文链路。协议、能力通告及取消规则见 PROTOCOL §4.24–4.25。

- 协议版本：`1`（`hello.protocol`）。
- 子协议：`pi-mobile-v1`；配对 `pi-pair.<code>`；token `pi-auth.<token>`；安装头 `X-Pi-Device-ID`。
- 256-bit 秘密 = 43 字符无 padding Base64URL；一切凭据校验先过这个形状。
- 设备注册表 JSON `{version:1, devices:[...]}`，存 `~/.config/pi-mobile-gateway/devices.json`（0600）。token 明文只在内存与网络中出现一次。
- 配对载荷 `{version:1, publicUrl, pairingCode, expiresAt}`，编码为唯一规范 wire 表示（Base64URL 文本）。

## 状态与生命周期

- 网关进程：SIGINT/SIGTERM → 关闭两监听面与全部 WS 连接 → 退出。
- 配对码：内存 Map，TTL 修剪在每次签发/领取时执行；进程重启全部失效。
- 设备连接：upgrade 成功时 `connected()`（在线计数 +1、lastSeen 持久化），socket close 时 `disconnected()`（计数 -1，幂等）。
- 测试注入：`createRegistry(file, { now })` 注入时钟；监听面用 `port: 0` 走临时端口。

## 测试与验收（阶段 1）

- `tests/devices.test.ts`：配对码单次性/TTL、token 轮换、吊销、持久化往返、注册表不落明文、在线计数。
- `tests/credentials.test.ts`：三种凭据来源的提取与拒绝（含"token 不进 query"）。
- `tests/pairing.test.ts`：编解码往返、拒绝 padding/标准 base64/裸 JSON/过期/版本不符。
- `tests/net-guards.test.ts`：私网判定、Host 白名单、同源校验、publicUrl 规范化。
- `tests/server.test.ts`：真机握手集成——401/403/404/400、paired→hello、token 重连、重放拒绝、过期配对码、query 配对路径、吊销在线连接 close 4003、超限帧 close 1009、畸形请求行不崩进程、管理面 CRUD/413/415/跨域 403/Host 403/publicUrl 校验。
- `tests/wire.test.ts`：事件投影（partial 剥离/id 提升/agent_end 裁剪/turn 省略）、工具调用归一、条目→消息渲染、活动分支切片与游标分页、字节上限、文件设置推导。
- `tests/pi-runtime.test.ts`：脚本化 FakeSession 注入——列表/running 标记、订阅转发与 seq、prompt 受理与串行化、历史分页、状态推导、新建会话、abort、空闲回收与虚拟时钟。
- `tests/router.test.ts`：真实 WS 端到端——sessions/history/state/subscribe/unsubscribe/abort/未知命令、message 校验矩阵、prompt-rejected、断线退订、事件投影在线上帧的形状。
- 手工 smoke：CLI `--pair` 打印二维码；`node scripts/smoke-verify.mjs` 全链路（配对→重连→心跳→重放拒绝→吊销踢连接→畸形请求存活 + 阶段 2 业务帧；`--prompt` 附加一条真实消息的端到端）。

## 评审修复记录（阶段 1 后独立 review）

独立 reviewer 发现 1 critical + 3 major，全部修复：

1. **critical**：畸形请求行（绝对形式 URL + 非法 IPv6 字面量）使 `new URL()` 抛异常逃逸 upgrade handler，未鉴权单包崩溃进程 → upgrade 顶层 try/catch + `reject(400)`。
2. **major**：吊销不关闭在线连接（dsh 原版 close 4003 语义丢失）→ registry 增加 `onRevoke` 通知，数据面按设备追踪连接并 close(4003, 'device revoked')。
3. **major**：管理面丢失原版跨域防护 → Host 白名单 + `isSameOrigin` + POST 强制 `application/json`（415）。
4. **major**：数据面丢失私网来源限制 → 移植 `isPrivateNetworkHostname`，非私网来源 403。私网判定含 RFC1918、RFC6598 CGNAT 100.64.0.0/10（Tailscale 等 mesh VPN 的节点地址，tailnet 不可公网路由，明文 `ws://` 威胁模型与 RFC1918 相同；注意 RFC6598 属"共享地址空间"，非 mesh VPN 场景下运营商 CGNAT 网内为订户共享语义，风险接受以 tailnet 的 WireGuard 点对点加密为前提）与 IPv6 ULA/链路本地。
5. 修复过程中测试再暴露同类 critical：**ws 库在协议级错误（超限帧）时会 `emit('error')`，服务端连接未挂 error 监听器则 uncaught exception** → 数据面为每个连接挂 error 吞掉（ws 已自行发起 close 1009）。
6. minor/nit：无效 JSON 400、超限 body 413、500 不回显内部信息、`/mgw/pair` publicUrl 签发前校验、CLI 启动失败友好报错、无可用地址拒绝生成二维码、删除 `revokedAt` 死字段。

## 阶段 2 设计记录（pi SDK 接入）

### 决策一：事件词汇 = pi 原生 + pi 自家 JSON 投影（原「直接映射」的落地形式）

- **选择**：`event` 帧的 `event` 字段直接承载 pi `AgentSessionEvent`，按 pi 官方 RPC stdout 协议的 JSON 投影语义裁剪（`message_update` 去累积快照 `partial`、`toolcall_start/delta` 提升 `id`/`toolName`）；另做 pi-web 同款的两处带宽裁剪：`turn_start`/`turn_end` 不下发（回合边界由消息序列隐式表达，阶段 4 轨迹视图需要时再以附加事件加回）、`agent_end.messages` 丢弃（每条消息已由 `message_end` 权威送达）。
- **否决项**：dsh 风格二次包装（`GatewayEvent{text,tool,turn,…}`）——fork 端要反向还原 pi 语义，两头维护；以及裸透传 SDK 原始事件——`partial`/`messages` 让移动端帧体积不可控。
- `toJsonEvent` 本身不是包的公开导出（类型 `JsonAgentSessionEvent` 是），故按 pi-web（MIT）的实现等语义自写投影，公开类型约束输出形状。

### 决策二：历史分页 = 文件条目 + 条目 id 游标（原「pi-web session-reader 路线」）

- **选择**：每次读会话 JSONL（`SessionManager.open` → `getEntries()`），沿活动分支从叶向根迭代切片（防深会话递归爆栈），再过 SDK 公开的 `buildContextEntries()` 做压缩感知，最后渲染成消息 + 平行 `entryIds`。分页游标 `beforeEntryId`（互斥），字节上限 2 MiB 保最新后缀（dsh 的 `capHistoryEvents` 语义）。
- **否决项**：`SessionManager` 内存快照路线——历史必须能服务"句柄已被空闲回收"的会话，且文件即真相，避免双读路径。
- 部分切片穿越压缩窗口时 `buildContextEntries` 优雅降级（摘要后的条目仍完整），与 pi-web 分页行为一致。

### 决策三：`message` 三态映射到单一 `prompt()` 入口

- `mode: "prompt"|"steer"|"followUp"` 全部走 `session.prompt(text, {streamingBehavior})`：`prompt()` 在空闲时立即执行、流式时按 `streamingBehavior` 排队——一个调用点覆盖三态，pi 自己处理状态机；
- 流式且未带 mode → SDK 抛错 → `prompt-rejected` 错误帧（pi RPC 同语义，不猜默认）；
- 应答时机 = pi preflight 受理（`preflightResult(true)`），非运行完成——受理后失败走事件流；prompt 受理做了串行化（pi-web 的 admission queue），并发发送时第二条能看到第一条的流式状态；
- `sent` 响应前先给发送连接挂上事件订阅，首批事件不可能先于订阅。

### 决策四：会话句柄生命周期

- 内存句柄 = SDK `AgentSession` + 每会话事件 `seq` + 订阅 sink 集合 + 受理队列；按需加载（订阅/发消息时），空闲且无订阅者 5 分钟由清扫器释放；**运行中/压缩中的句柄永不回收**——手机断线，pi 跑完整个 run；
- `dispose()` 走 SDK `dispose()`；网关进程退出时全部释放；
- 列表索引走 `SessionManager.listAll()` + 15s TTL；并发扫描共享同一失效代的promise，旧代结果不能回写新索引。打开已知会话可复用经文件存在和头ID核实的路径，正文仍按文件stat刷新，路径删除/身份变化重查；新建会话即失效。`sessionDir`覆盖贯穿create/open/listAll，测试用临时目录隔离。

### 决策五：扩展绑定 = `bindExtensions({mode:"rpc"})`，无 uiContext

- 与 pi 自家 RPC 模式同款调用；runner 对缺失 uiContext 有内置 `noOpUIContext` 兜底（对话框自动取消，不挂起），扩展加载失败仅记录不致命；
- 阶段 4 做 HITL 审批时，再把 `extension_ui_request` 转发给手机并应答 `extension_ui_response`（pi RPC 协议同款双向）。

### 决策六：并发构建去重（阶段 2 评审 M1）

- `openSession`/`createSession` 维护 in-flight Promise 表（pi-web `rpc-manager.ts` 的 startLocks 同款）：并发加载同一会话 / 同 cwd 并发新建**共享一次工厂构建**；
- 动机：两路并发构建会各自 `createAgentSession`，被覆盖的第一个实例成为孤儿（永不 dispose、清扫器不可见），挂到孤儿上的订阅者收不到后续 run 的事件；
- `buildSession` 另有幂等护栏：工厂运行期间若同 id 的存活句柄已注册，丢弃新实例复用旧句柄（公开接口在锁之后不可达，纵深防御）。

### 决策七：出站体积预算（阶段 2 评审 M2）

- 预算常量：实时事件帧 1 MiB（与入站帧上限对称）、历史单条消息 512 KiB（必须低于 2 MiB 页上限）；
- 策略 = 先测量、超限才降损（`shrinkForWire`）：图片 base64 → `{dataOmitted, dataBytes}` 元数据占位（小图不受影响，完整图片投递/延后拉取是阶段 4）、超 10 万字符的字符串截断加 `[已截断]` 尾标；
- 仍超限的兜底：事件帧 → `event_omitted` 存根（seq 照常推进，客户端用 history 对账）；历史消息 → `wire-oversized` 存根。由此 **2 MiB 页上限恒成立**（单条超大消息不再能击穿分页契约）；
- 否决项：pi-web 的 deferred-fetch 路线（客户端按需拉图片/思考）——需要新增只读拉取 API，属阶段 4 轨迹/图片工作的一部分；
- 成本注记：每个事件帧在投影后多一次 JSON 序列化用于测长（发送时还有一次），个人使用量级可接受。

### 决策八：错误卫生与容量上限（阶段 2 评审 m4/m6）

- `internal` 错误帧的 `message` 恒为 `"internal error"`；原始错误（可能含文件路径）只进网关日志（router 挂 `log` 回调，main.ts 前缀 `[router]`）——session-not-found / bad-request / prompt-rejected 保持 client-facing 文案；
- 会话句柄数上限 16（`maxLoadedSessions` 可调）：超限淘汰最旧的无订阅者空闲句柄，运行中/有订阅者的永不淘汰；
- 已记录边界：历史读取为同步文件解析（`SessionManager.open + getEntries` 在事件循环上，单文件 MB 级为个人使用量级可接受），阶段 4 引入轨迹视图时如有需要再评估 worker 化。

### 测试与注入

- `sessionFactory` 可注入：单测用脚本化 FakeSession（accept/emit/abort 可编程），不加载真实 pi 资源、不碰真实 `~/.pi`、不调真实模型；
- `sessionDir` 可注入：历史/索引测试用临时目录手工构造 JSONL；
- 时钟可注入（`now`），空闲回收测试推进虚拟时钟；
- 真实链路由 `scripts/smoke-verify.mjs` 覆盖：`--prompt` 可选发一条真实消息（新会话 + 事件流 + 落盘后 history 回读），默认只读不产生模型调用。

## 待决策项

- WSL2 局域网直连方案（mirrored networking / portproxy / Tailscale）在阶段 5 与 Android 真机联调时定。


### Pi 会话树展示（tree-view-v1）

新客户端把搜索、过滤模式和折叠ID作为一次树快照的参数交给网关。网关复刻所锁定SDK的可见树投影，返回平铺行、Pi前缀和正文；客户端只负责横向/纵向浏览、焦点与触控，不根据parentId再次计算深度。此接口保留全部匹配节点，客户端使用惰性列表；旧无view请求继续保留400条窗口和旧正文形状。普通消息搜索使用SDK的200字符窗口，不将它描述为全文索引。节点点击仍走既有switch-branch，不扩展持久化或模型调用。代码部署需独立服务重启，本轮不自动重启运行中的服务。

## r21 真机验收调整（2026-10-07）

Provider按来源分开：可编辑配置仍由PiProviderStore管理models.json，SDK生成的models-store.json独立白名单只读，不把缓存项拼进provider-put。两次稳定读取与有限重试容忍SDK原地写缓存；格式错误单独报告，配置列表仍可见。模型菜单以Pi getAvailable与enabledModels为准，连接测试状态不再额外隐藏模型。

history-turns-v1保留旧entry分页兼容。活动分支上的真实user到最终assistant为一轮，steer在轮内，工具调用不切轮，未完轮仍显示。请求最多10轮，预算仅按整轮缩页；单轮超限明确失败。手机端仅用户向旧记录滚动时分页，latest刷新有可证明条目重叠时保留较旧前缀及原游标，无重叠不猜接历史。

## r23 模型范围与历史读取（2026-10-08）

模型定义与菜单范围分别管理。菜单默认解析Pi全局settings.json的enabledModels，不把网关工程项目设置当用户全局scope；Provider保存不自动追加provider/*。空或全部无匹配scope按Pi默认回到可用目录，部分无匹配项省略。恢复已有会话传scope但不覆盖记录中的模型和思考档位；本轮不迁/model的all切换、项目scope编辑或/scoped-models临时编辑。Provider模型调序属于手机视图和探针测试次序，不改变宿主配置的模型顺序。

已知路径复用与并发索引合并只减少目录扫描，不长期缓存正文，也不改变10轮、活跃分支、实时尾及预算语义。阶段耗时日志只包含耗时与条目数。合成测量只说明网关读取耗时，手机端到端延迟仍需在真实网络和设备上验证。

## r25 两级模型地址与全局范围编辑（2026-10-08）

模型有效地址遵循Pi的 model.baseUrl > provider.baseUrl。地址读出不含凭据；手机未编辑省略字段保留旧覆盖，显式null删除覆盖恢复继承，字符串原样覆盖。草稿探针的独立modelBaseUrl带相同三态，不把公共地址误当模型覆盖，不自动裁加/v1。已存诊断只认证与探测配置一致的当前模型。

模型范围编辑单独读取全部可用目录及全局patterns，通过公开SDK resolver展开勾选并保留原思考级别。只有显式保存写具体provider/model[:level]，既有无匹配条目单列、默认保留；不新增通配符。恢复默认写空数组以沿用Pi全量目录语义。保存串入settings写队列，并核对读取快照、flush/reload确认落盘，其他settings字段保持；前后发现配置变化拒绝或报告未确认，不宣称跨进程原子锁。保存不会调用setModel；项目或会话临时scope未迁移。应答及错误回显scopeRequestId，手机只接受自己的在途终态；超时/断连保留草稿并要求重读确认。
