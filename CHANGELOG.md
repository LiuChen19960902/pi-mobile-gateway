# Changelog

## [Unreleased]

### Added

- `extension-status` 帧与同名能力：通过 Pi 公开扩展 API `ctx.ui.setStatus` 发布会话级状态行（子 agent 运行、后台任务等），`subscribed` / `session-restarted` 携带快照，实时变化以完整快照推送；网关只桥接这一显示原语，其余扩展 UI 方法保持 no-op。状态是显示提示，不定义任务终态，也不参与会话保活。
- `attachment` 帧：按 `sessionId + entryId + imageIndex` 从 pi 会话条目按需取回历史图片（活动会话优先、回落文件视图；单图原始 ≤4 MiB；错误以关联三元组回显）；`hello.capabilities` 增加 `attachment`。
- 事件帧新增顶层 `entryId`（pi 条目身份）：在 pi emit→append 微任务窗口后按对象引用匹配 `SessionManager.getEntries()` 得出，history 平行 `entryIds` 对应；客户端据此做实时/历史消息身份合并。
- `history` 未落盘窗口恢复：①会话尚无 assistant（首轮未落盘）②流式中 emit→append 间隙——当文件视图是 live 条目前缀时，把 live 尾部条目并入 history 并按 live 叶子切换活跃链；`latestEntryId` 并入时取 live 叶子。外部重写文件不满足前缀时不合并（不复活陈旧条目）。
- `name` / `compact` 帧：会话改名（≤200 字符）、手动触发上下文压缩。
- `tree` / `switch-branch` 帧：Pi 会话树（支持搜索、筛选、折叠与活跃路径高亮）及活动位置切换（对齐 pi TUI，固定 `summarize:false`；需先 `subscribe`）。
- `entry-copy` / `label-put` 帧（特性名 `tree-actions-v1`）：树页动作接线。`entry-copy` 对齐 Pi TUI Ctrl+X 的 `getEntryCopyText`，回整条 entry 的可复制全文（不是 120 字预览）；无可复制文本回 `entry-copy-empty`，超 512 KiB 只回 `oversized`+`bytes`，不静默截断。`label-put` 对齐 Shift+L 的 `appendLabelChange`：只追加 `LabelEntry`（`targetId` 指向选中条目、最后记录生效、空值清除），写入后同步手动叶子钉子使 `tree` 的 `leafId`/`selectedId` 不错位；需 live 句柄，标签上限 200 字符。
- `restart-session` 帧：重建会话并重读全部配置（对齐桌面 pi 重开语义；运行中拒绝）。
- `commands` 帧：自定义命令清单（扩展/模板/skill 三源聚合）。
- `providers` / `provider-put` / `provider-delete` / `provider-test` / `provider-models` 帧：手机端读写宿主 models.json、按协议连通性测试、拉取上游模型清单；`provider-test` 应答带 `failureKind`（网络类失败归 `transient`，不据以禁用 provider）。

### Changed

- `provider-put` 缺省语义：`name`/`baseUrl`/provider 级 `api` 缺省保留原值（原缺省清除）；`apiKey` 缺省保留不变；必填校验（`id`，`baseUrl`/`apiKey` 至少其一）不变。
- `message images` 上限 8→4（与 18 MiB 帧上限的 4 张预算对齐，手机端同为 4）。
- `provider-test` 的 `openai-responses` 协议改走 `/responses` 端点（`input`/`max_output_tokens`），与 pi-ai 实际请求一致；此前误走 `/chat/completions`。
- `history` 支持 `turnLimit`（最多 10 轮），并保留原始条目 `limit` / `beforeEntryId` 分页；单轮超出预算时客户端改用条目分页。

### Fixed

- 手动压缩的启动等待也计入运行中状态，同会话重复触发合并；结束后排空 Pi 事件并通知最终状态，避免抽屉残留进行中。
- 消息回执区分输入已消费与运行结束；停止和独立队列取回对齐 Pi 的 clearQueue / abort 语义。
- 出站截断保持 UTF-16 代理对完整（`src/wire.ts` `truncateUtf16`）：正文（`WIRE_TEXT_MAX_CHARS`）、树预览（`TREE_PREVIEW_MAX_CHARS`）与 assistant 错误预览三处按 UTF-16 单元截断时，切点若落在有效代理对中间则退一单元，不再产生孤立代理（严格上游/客户端会拒收含孤立代理的整帧）。
- `POST /mgw/devices/:id/revoke` 强制 `application/json`（缺省/错误类型 → 415），与 `/mgw/pair` 同口径。
- `workspace-create` 已存在文件时报 `bad-request`“不是目录”（原 `internal`）。
- 设备连接落盘失败时回滚在线计数（`/mgw/status` 不再虚高）。
- 纯图消息（`text` 为空 + `images` 非空）不再被 “message requires non-empty text” 拒绝。
- CLI 启动校验 `--public-url` 复用 `normalizePublicUrl`（配对不再签发被管理面拒绝的公网明文地址）；仅检测到公网网卡且未请求配对时按回环入口正常启动，不再误拒。

## [0.5.1] - 2026-10-25

- 新增 `session-presence-v1`：列表请求可核验客户端已知会话路径，并通过 `deletedSessionIds` 显式确认闲置会话已从宿主删除。
- 扫描不完整、目录不可访问或会话仍由 SDK / 原生 Pi 实例持有时保留条目；普通 JSONL 日志不阻塞无关会话的删除确认。
- 与 Android 1.2.2 配套使用；旧客户端或未宣告该能力的旧网关保持原来的列表合并行为。

## [0.5.0] - 2026-10-23

### Added

- `bridge` / `host-mode` / `host-mode-put`：连接电脑上已加载桥接扩展的原生 Pi 实例，按会话 `instanceId+epoch` 隔离实时状态，写请求按 `operationId` 去重；桥接模式操作同一个原生实例，并支持后台启动、模型/思考切换、上下文压缩、会话树与输入补全；会话/Worktree动作复用原生公开API。
- `bridge-start`：对离线会话在宿主 tmux 中后台启动带桥接扩展的原生 Pi，等注册表出现描述符才回 `bridge-started`；按 `operationId` 与 `sessionId` 双重去重，超时回 `launch-result-unknown`。附带 `pi-mobile attach <sessionId>` 附着入口。
- 限时六位手输配对码，与二维码/配对文本共享一次性消费和失败预算。
- 原生会话的模型、压缩、会话树、输入补全与工作区控制；提供后台 Pi 的用户服务示例和生命周期说明。

### Fixed

- 桥接 IPC 单帧统一按字节限制 24 MiB：扩展响应超限以同 id 回 `frame-too-large`，网关读缓冲超限先拒绝在途请求再关闭 socket，不再把超限误报为 `bridge-offline`。
- 桥接事件只在 `bridge-snapshot` 建立新代际；旧 epoch 迟到事件丢弃，同代际倒退 `bridgeSeq` 丢弃。模式切换释放旧订阅并通知客户端，避免旧订阅静默失效。

## [0.4.0] - 2026-10-19

### Added

- `worktree-v1`：发现和创建 Git worktree，通过 Pi 公开会话 API 在目标继续完整上下文，保留源会话；项目资源先确认信任。同次操作以 UUID 去重，失败重试复用副本，结果未知时查询而不重复创建；不自动提交或携带未提交文件。

## [0.3.0] - 2026-09-14

移动端体验收敛与初始模型语义对齐 pi CLI。

### Added

- `message` 帧新增可选 `model` 预选字段：新建会话在发送首轮 prompt **之前**应用 `setModel`（对齐 pi CLI "先选模型再发" 的次序），失败回 `bad-request` 且会话不入列表。新会话初始模型与 pi CLI 同源：全局 `enabledModels` 非空时按 scope 解析（defaultModel 在范围内优先、否则范围第一项，`selectInitialScopedModel` 纯函数），未配置范围才回落 pi 内置兜底；pattern 的 `:level` 后缀档位一并透传（对齐 CLI `options.thinkingLevel`），scope 解析带 CLI 同款 15s 超时，失败即拒绝创建（fail loud，无降级）。
- `history` 还原增强：pi 会话文件里 `empty-stop-retry` 的 `role:"custom"` 条目转 wire 消息（details 携带 attempt/reason/model），客户端可还原"上游空回复"实时提示；未知模型在会话创建**之前**预校验（`modelDefinitionExists`，对齐 CLI `process.exit(1)` 不落会话文件），auth 等深层校验仍留 set-model。
- 业务帧 `models`：已配置认证的模型目录（pi `ModelRuntime.getAvailable()`），按 provider 分组；每个模型带 `id/name/contextWindow/maxTokens/reasoning/input/thinkingLevels`，其中 `thinkingLevels` 与 pi `getSupportedThinkingLevels()` 一致（非推理模型只有 `off`，`xhigh`/`max` 需模型显式映射）。全局 settings 的 `enabledModels` 非空时按 pi TUI 选择器同口径过滤（复用 pi `resolveModelScopeWithDiagnostics`：精确 `provider/model`、glob 通配与 `:level` 后缀；无命中的 pattern 省略；未配置或读取失败不过滤），`PiRuntimeOptions.enabledModelsLoader` 可注入（测试不触碰真实 `~/.pi`）。
- 业务帧 `set-model`：**会话级**切换模型（pi `setModel(model, {persist:false})`，追加 `model_change` 条目、resume 后保持，不改全局默认）；可选 `thinkingLevel` 在切换**之后**应用（pi 切换模型会先把档位重置为新模型默认值），应答回传实际生效值，形状为一次 `state` 快照。
- `hello.capabilities` 增加 `models`、`set-model`。
- `PiRuntime` 新增 `listModels()` / `setModel()`，以及可注入的 `ModelRegistryLike`（测试注入脚本目录，不触碰真实 `~/.pi`）；`PiSessionLike` 增加 `setModel` / `setThinkingLevel`。
- 测试 132：新增 `models` 目录分组与档位推导、`set-model` 会话级切换与参数/未知模型/未知会话拒绝、以及“回传 pi 实际生效档位（clamp）”的 runtime 与端到端帧测试。

### Changed

- `PiRuntimeOptions` 新增 `agentDir`（pi `SettingsManager.create(cwd, agentDir)`）：测试读写全部落临时目录，不触碰真实 `~/.pi`；`enabledModelsLoader`/`enabledModelsRemover` 可注入；provider-delete 成功后对称清理 `enabledModels` 里对应 pattern（幂等）。测试 154 项全绿。
- 协议文档新增 §4.13 `models` / §4.14 `set-model`，§1.5 能力表与 `hello` 示例同步；`input` 字段限定为 `["text"]` / `["text","image"]` 封闭集合（缺失/未知模态回退 `["text"]`）。

### Fixed

- `provider-delete` 不再遗留 `enabledModels` 中的 `provider/*` pattern（此前删除 provider 后目录过滤仍按旧 pattern 计算）。
- 管理面 `POST /mgw/pair` 未带 `publicUrl` 时回退到硬编码的 `ws://127.0.0.1:<port>/ws/mobile`，忽略了 `--public-url`（启动时的 `--pair` 用的是配置值）。结果是经管理面生成的配对码只在本机可达，手机走 Tailscale/LAN 无法使用。现改为默认使用配置的 publicUrl。

### Chores

- 清理排查期调试日志：入站帧 `ws frame` 逐帧日志、message 帧落盘 `/tmp/last-message-frame.json`、`listModels` 计数日志；保留错误与生命周期日志。

## [0.2.1] - 2026-09-01

修复并发正确性、出站体积预算与错误信息问题，并对齐协议文档。

### Fixed

- 并发加载同一会话（双击连发、多设备同时订阅）不再各自构建重复的 `AgentSession`：in-flight 去重锁保证共享一次构建，消除孤儿句柄（永不 dispose、订阅者收不到事件）与同 cwd 并发新建重复会话。
- 出站帧体积上限：实时事件帧超 1 MiB 先降损（图片 base64 → 元数据占位、超长文本截断）再降级为 `event_omitted` 存根；历史单条消息超 512 KiB 同样降损，仍超限替换为 `wire-oversized` 存根——"每页 2 MiB"分页契约不再被单条超大消息（图片附件/巨型工具输出）击穿。
- `message_update` 的 `usage` 改为从快照 `message.usage` 取（pi 自家投影语义；此前读不存在的顶层字段，流式 token 用量对手机不可见）；测试夹具改为真实 SDK 形状。
- `beforeEntryId` 指向文件内存在、但不在活动分支上的条目时，现在明确报错，而不是静默返回祖先页。
- `internal` 错误帧改为固定通用文案（原始错误只进网关日志，不再回显可能含文件路径的信息）。
- `sessions` 列表的 15s TTL 缓存写入协议文档（原"不缓存"表述与实现矛盾）。
- 同步解析会话文件的事件泵包上 try/catch（SDK 监听器内异常不再可能打断事件泵）。
- 新增并发句柄上限（默认 16），超限淘汰最旧空闲句柄。

### Added

- `wire.ts` 出站预算 API：`shrinkForWire` / `sanitizeHistoryMessage` / `oversizedEventStub` / `oversizedMessageStub` 与常量 `WIRE_EVENT_MAX_BYTES`、`WIRE_HISTORY_MESSAGE_MAX_BYTES`、`WIRE_TEXT_MAX_CHARS`。
- 测试 104 → 120：并发构建去重、句柄上限淘汰、事件/历史体积降损与存根、抛弃分支游标拒绝、错误卫生，以及真实 SDK 形状的投影夹具。

## [0.2.0] - 2026-09-01

阶段 2：pi SDK 进程内接入，数据面从"连接管理"升级为完整的会话遥控面。

### Added

- pi 会话运行时（`src/pi-runtime.ts`）：通过公开 SDK（`createAgentSession` + `SessionManager` + 共享 `ModelRuntime`）进程内驱动 pi；会话按需加载、事件订阅、prompt 受理串行化、空闲 5 分钟自动回收（运行中永不回收——手机断线，pi 跑完整个 run）。
- 业务帧（`src/router.ts`，骨架沿用 dsh、载荷 pi 原生）：
  - `sessions`：会话列表（id/路径/cwd/首条消息/运行中标记，按最近修改排序）；
  - `message`：续聊（`sessionId`）或新建（`cwd`）；`mode: prompt/steer/followUp` 映射 pi `prompt(streamingBehavior)`；受理即回 `sent`，失败语义对齐 pi RPC（`prompt-rejected` 同步拒绝、受理后失败走事件流）；发送连接自动订阅；
  - `subscribe`/`unsubscribe`：按连接隔离的事件流订阅（断线自动退订）；
  - `history`：活动分支历史，条目游标 `beforeEntryId` 向后分页，压缩感知（`buildContextEntries`），2 MiB 字节上限保最新后缀；
  - `state`：轻量状态轮询（模型/思考等级/流式/队列/上下文占用），断线重连对账用；
  - `abort`：中止当前运行。
- 事件推送（`kind:"event"`）：pi `AgentSessionEvent` 直投，按 pi 官方 RPC JSON 投影语义裁剪（`message_update` 去 `partial`、`toolcall_*` 提升 `id`/`toolName`），另加 pi-web 同款带宽裁剪（`turn_*` 省略、`agent_end.messages` 丢弃）；每会话单调 `seq`。
- 会话条目→消息渲染：文件格式工具调用块归一为运行时形状，历史与实时事件流形状一致；compaction / branch_summary / custom_message 条目按 pi-web 语义渲染。
- `hello` 帧新增 `capabilities` 特性通告。
- CLI `--session-dir`：pi 会话目录覆盖（隔离测试/多实例）。
- 测试从 53 个增至 104 个：wire 投影/切片/上限、pi-runtime（脚本化 FakeSession 注入：列表/订阅转发/prompt 受理/历史分页/状态推导/空闲回收/虚拟时钟）、router 真 WS 端到端（业务帧矩阵 + 错误矩阵 + 断线退订）。
- smoke 扩展阶段 2 段：sessions/history 分页/state/subscribe/校验错误；`--prompt` 附加一条真实消息的完整端到端（新建会话→事件流→落盘回读）。

### 来源说明

- 事件投影与会话读取语义参考 [pi-web](https://github.com/agegr/pi-web)（MIT）与 pi 自家 RPC 协议（`docs/rpc.md`）；帧骨架沿用 [dsh-plugin-mobile-gateway](https://github.com/Clarklevis1995/dsh-plugin-mobile-gateway)（MIT）。

## [0.1.1] - 2026-09-01

### Fixed

- 畸形请求行不再使进程崩溃（未鉴权单包 DoS）。
- 吊销设备现在立即关闭其全部在线连接（close code `4003`，移植 dsh 原版语义）。
- 数据面恢复私网来源限制：非回环/私网来源返回 `403`，明文 `ws://` 不出私网。
- 管理面恢复浏览器攻击防护：Host 白名单（防 DNS rebinding）、同源校验（防 CSRF）、POST 强制 `application/json`（`415` 阻断跨域简单请求）。
- 服务端连接挂接 ws error 监听：协议级错误（如超限帧）不再成为 uncaught exception。
- 无效 JSON body 返回 `400`（原为 500）；超限 body 返回 `413`（原为连接重置）；`500` 不再回显内部错误信息。
- `/mgw/pair` 的 `publicUrl` 签发前校验（`ws://` 仅限私网、拒绝内嵌凭据/query/fragment）。
- CLI 启动失败（端口占用等）友好报错退出；无法推断手机可达地址时拒绝生成配对二维码。
- `hello.port` 报告实际绑定端口；HTTP 拒绝响应补 Content-Type 与字节级 Content-Length。
- 删除注册表 `revokedAt` 死字段。

### Added

- `src/net-guards.ts`：私网判定、Host 白名单、同源校验、publicUrl 规范化（移植自 dsh-plugin-mobile-gateway）。
- `scripts/smoke-verify.mjs`：端到端手工 smoke（配对→重连→心跳→重放拒绝→吊销踢连接→畸形请求存活）。
- 测试从 32 个增至 53 个：net-guards 单测、过期配对码、query 配对路径、吊销踢连接 4003、超限帧 1009、畸形请求行、管理面 400/413/415/403、publicUrl 校验。

## [0.1.0] - 2026-09-01

### Added

- 阶段 1 骨架：数据面 WebSocket（`/ws/mobile`，强制设备鉴权）与 localhost 管理面双监听架构。
- 设备注册表：一次性 5 分钟配对码（仅内存）、长期 token 只落 SHA-256 摘要、同安装 ID 重配对即 token 轮换、吊销、原子持久化。
- 凭据提取：`Authorization: Bearer` / 子协议 `pi-auth.`、`pi-pair.` / query 配对码回退；长期 token 禁止 query。
- 配对载荷严格 Base64URL 编解码与版本/过期校验。
- 数据面帧：`paired` / `hello` / `pong` / `error`；401/400/404 升级拒绝语义。
- 管理面 API：`/mgw/status`、`/mgw/pair`、`/mgw/devices`、`/mgw/devices/:id/revoke`。
- CLI：局域网 IP 推断、终端二维码（`--pair`）、可配置端口与设备文件。
- 32 个单元/集成测试覆盖注册表、凭据、配对编解码与真机握手全链路。

### 来源说明

- 鉴权与设备注册表设计移植自 [dsh-plugin-mobile-gateway](https://github.com/Clarklevis1995/dsh-plugin-mobile-gateway)（MIT）。
