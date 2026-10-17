# pi-mobile-gateway

让手机通过**设备鉴权的 WebSocket** 连接并使用本机的 [pi](https://github.com/earendil-works/pi) coding agent：把 pi 的会话、实时回复和 Agent 执行轨迹带到移动端。

配套 Android 客户端为 [pi-mobile-android](https://github.com/LiuChen19960902/pi-mobile-android)，版本 Android 1.0.0 ↔ gateway 0.3.0。网关使用锁定的 Pi SDK 1.3.0；终端 Pi 的安装与网关 npm 依赖独立，升级后需核对两者契约。

## 架构

```text
手机 App（Android 客户端）
    │ WebSocket（设备鉴权）
    ▼
pi-mobile-gateway（本仓库，跑在 pi 同机）
    │ SDK 进程内（@earendil-works/pi-coding-agent）
    ▼
pi coding agent（会话与模型调用发生在电脑上，手机只是遥控器）
```

网关分为面向手机的数据面和仅限本机的管理面，并分别校验鉴权与来源：

| 面 | 绑定 | 能力 |
| --- | --- | --- |
| 数据面 `:3082` | `0.0.0.0`（默认全部网卡；`--bind <IP>` 可收紧到单网卡，如仅 mesh VPN 地址） | 仅 `/ws/mobile` WebSocket 升级，强制鉴权 |
| 管理面 `:3083` | `127.0.0.1` | 配对码签发、设备列表/吊销、状态查询 |

## 安装

```bash
git clone https://github.com/LiuChen19960902/pi-mobile-gateway.git
cd pi-mobile-gateway
npm ci
```

要求：Node.js `>=22.19.0`（WSL2 环境同样适用）。文件补全需要运行网关的 `PATH` 中有 `fd`。若发行版安装为 `fdfind`，可在个人 bin 目录提供名为 `fd` 的链接并将该目录加入服务的 `PATH`；服务启动环境与交互终端可能不同。

## 使用

```bash
npm start                        # 常规启动
npm start -- --pair "我的手机"    # 启动并生成配对码，终端打印二维码
npm start -- --data-port 3082 --mgmt-port 3083
npm start -- --device-file /path/to/devices.json
npm start -- --session-dir /path/to/sessions   # pi 会话目录覆盖（调试/隔离用）
npm start -- --public-url "ws://<宿主IP>:3082/ws/mobile"
```

首次配对流程：

1. 手机与电脑同一局域网，启动网关并 `--pair`；
2. 终端出现的二维码 / 手动文本（严格无 padding Base64URL，30 分钟过期、仅可使用一次）；
3. 手机扫码或粘贴文本建立连接，收到一次性的 `paired` 帧并保存长期 token；
4. 之后手机用 `Authorization: Bearer <token>` 重连。

## 数据面能力

客户端连上后可用的业务帧（协议详见 [PROTOCOL.md](PROTOCOL.md)）：

| 帧 | 说明 |
| --- | --- |
| `sessions` | 列出 pi 会话（id/路径/cwd/首条消息/运行中标记） |
| `message` | 发送消息：续已有会话（`sessionId`）或新建（`cwd`）；空闲时直接执行；流式中 `steer` 插入本轮、`followUp` 排到下轮，`prompt` 或未指定模式则拒绝；SDK 正在压缩时拒绝发送 |
| `subscribe` / `unsubscribe` | 订阅会话实时事件流（pi 事件 JSON 投影，单调 `seq`） |
| `history` | 活动分支历史，支持按 turn 分页或条目游标分页，压缩感知 |
| `state` | 轻量状态轮询（模型/思考等级/流式/队列/上下文占用） |
| `abort` | 中止当前运行 |
| `models` / `set-model` | 可用模型按 Pi 全局 `settings.enabledModels` 范围过滤 / 切换（含 thinking 等级） |
| `model-scope` / `model-scope-put` | 读取和设置 Pi 全局模型范围，保存具体模型 ID，不切换当前会话模型 |
| `name` | 会话改名 |
| `compact` | 调用 Pi SDK 手动压缩，沿用宿主加载的压缩 hook；同会话重复触发合并 |
| `providers` / `provider-put` / `provider-delete` | 手机端读写宿主 models.json（`apiKey` 盲存盲回，缺省保留） |
| `provider-test` / `provider-models` | 逐模型协议与 Base URL 的上游连通性测试/ 拉取上游模型清单；两者会让网关向用户填写的 `baseUrl` 发起出站请求 |
| `directories` / `directory-create` / `workspace-create` | 宿主目录浏览、新建文件夹、新会话落点 |
| `tree` / `switch-branch` | Pi 会话树与活动位置切换（需先 `subscribe` 打开会话），支持搜索、筛选与折叠 |
| `entry-copy` / `label-put` | 树页动作：整条 entry 的可复制全文（Pi Ctrl+X，>512 KiB 只报 `oversized`）/ 标签写（Pi Shift+L，需 live 会话；追加 `LabelEntry` 并推进叶子）；特性名 `tree-actions-v1` |
| `restart-session` | 重建会话（对齐桌面 pi 重开语义） |
| `commands` | 自定义命令清单（扩展/模板/skill 三源） |
| `input-resources` / `input-completions` | 当前工作区的 Skill/Prompt 发现与 `@` 文件/目录补全 |
| `attachment` | 按条目按需取回历史图片（单图 ≤4 MiB，缓存优先） |

事件（`message_start/update/end`、`tool_execution_*`、`agent_*`、`queue_update`、`compaction_*`…）与 pi 自家 RPC 协议同词表；会话在内存中按需加载、空闲 5 分钟释放，**运行中的会话即使手机断线也跑完**。

## 管理面 API（localhost）

| 方法与路径 | 说明 |
| --- | --- |
| `GET /mgw/status` | 数据面端口、推断的手机可达地址、设备列表 |
| `POST /mgw/pair` | 签发配对码，body `{"name": "...", "publicUrl": "..."}`（均可选） |
| `GET /mgw/devices` | 已配对设备与在线状态 |
| `POST /mgw/devices/:id/revoke` | 吊销设备 |

## 安全模型

**关键性质**

- 长期设备 token 256-bit 熵，**只落盘 SHA-256 摘要**，永不存明文；
- 配对码一次性、30 分钟 TTL、只存内存，重启即作废（已配对设备不受影响）；
- 领取即消费（claim-then-delete）：即使后续升级失败配对码也不可重放；
- 同一安装 ID 重新配对 = 凭据轮换，不产生重复设备行；
- token 摘要比对使用 timing-safe 比较；注册表原子写入（tmp+rename），文件 0600、目录 0700；
- 长期 token 不接受 URL query 传递（避免进入代理日志）；配对码优先走 WebSocket 子协议；
- 吊销立即生效：token 失效 + 在线连接以 close `4003` 关闭；
- 数据面对来源做私网判定（`403` 拒绝非回环/私网来源）。**该检查看的是 TCP 对端地址，不保证公网不可达**：端口转发/DNAT（如 Docker `-p`）会把公网来访呈现成网桥私网地址，反代同理呈现代理本机地址——不要据此把端口发布到公网；
- 管理面绑定 `127.0.0.1` + Host 白名单 + 同源校验 + POST 强制 `application/json`（防 CSRF / DNS rebinding；管理面无用户隔离，假定宿主机本身是单用户可信环境）；
- 配对载荷 `publicUrl` 签发前校验（`ws://` 仅限私网，公网必须 `wss://`，拒绝内嵌凭据）；
- 鉴权永远开启，无调试后门。
- **设备 token 等价于宿主执行权限**：pi 是 coding agent，通过鉴权的客户端可借 pi 在宿主机执行任意代码、读写文件——不要把 token 发给你不信任的设备；
- `provider-test` / `provider-models` 会让网关向用户在表单里填写的 `baseUrl` 发起出站请求（HTTP 时 API Key 明文传输），不要填不可信地址；

**有意偏离**

- 不做“无连接 N 分钟自动关闭”的节省模式：独立进程的启停本身就是开关；
- 不做多监听形态：单一数据面监听 + 私网来源检查达成同等效果。

公网部署必须前置 TLS 反向代理（`wss://`），不要把 3082/3083 直接暴露公网。既然明文 `ws://` 只适合可信网络，且来源检查不能替代网络层隔离，请把网关放在你可控的私网/tailnet 内。

## 开发

```bash
npm ci
npm run typecheck
npm test
npm run lint
```

手工 smoke（网关运行中）：

```bash
node src/main.ts --device-file <临时路径> --pair "测试"   # 终端一
node scripts/smoke-verify.mjs                              # 终端二：端到端校验
node scripts/smoke-verify.mjs --prompt                     # 附加一条真实消息的端到端
```

协议详见 [PROTOCOL.md](PROTOCOL.md)，设计决策详见 [DESIGN.md](DESIGN.md)。

## 协作与自动检查

[GitHub CI](.github/workflows/ci.yml)在Linux上执行上节的类型、lint和单测检查，单测按文件串行运行。CI使用隔离配置，不需要真实Provider密钥。提交PR时说明实际验证；协议变化需同步手机端及跨仓一致性测试。依赖更新通过PR处理，不自动合并。

## 限制

- 日常验证环境为 Windows + WSL2。另在 Ubuntu 26.04.1 / x86_64 / Node.js 24.21.0（已配置 `fd`）验证过 gateway 0.3.0 的较早快照：安装、配对、Provider 配置、真实聊天、工具及历史主路径通过；最新树页动作和手动压缩未在该机复验。纯 Windows、macOS 和其他 Linux 环境未验证。

- 图片附件、模型切换、会话树导航、Provider 管理、目录浏览与输入补全已实现（见上方帧/说明表）；
- 局域网明文 `ws://` 仅限可信网络；公网必须 `wss://` + 反向代理；
- Provider API Key 由手机表单经 `provider-put` 写入宿主 models.json（网关盲存盲回、不做 OAuth/刷新）；
- 扩展 UI 交互（`extension_ui_request`）由 pi 的 no-op 兜底自动取消，尚无移动端审批等价物。
