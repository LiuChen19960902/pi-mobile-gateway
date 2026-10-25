import { install } from "undici";

// SDK 会话工厂不执行 CLI 的 HTTP 初始化；Node 内置 fetch 也可能含旧版漏洞。
// 在加载 SDK 前安装同一补丁实现，避免只修 npm 依赖而实际仍走内置 fetch。
install();
