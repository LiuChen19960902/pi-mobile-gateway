// CLI entry point: `node src/main.ts`
//
// Starts both listeners and prints where to reach them. Use --pair <name> to
// mint a pairing code at startup and render its QR in the terminal.

import { homedir, networkInterfaces } from "node:os";
import { dirname, resolve } from "node:path";
import process from "node:process";
import qrcode from "qrcode-terminal";
import { createRegistry } from "./devices.ts";
import { startMgmtPlane } from "./mgmt.ts";
import { isPrivateNetworkHostname, normalizePublicUrl } from "./net-guards.ts";
import { encodePairingText } from "./pairing.ts";
import { PiRuntime } from "./pi-runtime.ts";
import { ProviderStatusStore } from "./provider-test.ts";
import { connectClient } from "./router.ts";
import { startDataPlane } from "./server.ts";

const DEFAULT_DATA_PORT = 3082;
const DEFAULT_MGMT_PORT = 3083;

function usage(): string {
	return [
		"用法: pi-mobile-gateway [选项]",
		"",
		"选项:",
		"  --data-port <端口>    数据面 WebSocket 监听端口 (默认 3082)",
		"  --bind <地址>         数据面绑定地址 (默认 0.0.0.0；共享局域网时建议只绑 mesh VPN/私网地址)",
		"  --mgmt-port <端口>    管理面 HTTP 监听端口，仅绑定 127.0.0.1 (默认 3083)",
		"  --device-file <路径>  设备注册表文件 (默认 ~/.config/pi-mobile-gateway/devices.json)",
		"  --session-dir <路径>  pi 会话目录覆盖 (默认跟随 pi 自身设置)",
		"  --public-url <URL>    配对载荷中的数据面地址 (默认按局域网 IP 推断)",
		"  --pair <名称>         启动时生成一个配对码并在终端打印二维码",
		"  --help                显示本帮助",
	].join("\n");
}

interface CliOptions {
	dataPort: number;
	mgmtPort: number;
	deviceFile: string;
	sessionDir?: string;
	publicUrl?: string;
	pairName?: string;
	bindHost?: string;
	help: boolean;
}

function parseArgs(argv: string[]): CliOptions | { error: string } {
	const options: CliOptions = {
		dataPort: DEFAULT_DATA_PORT,
		mgmtPort: DEFAULT_MGMT_PORT,
		deviceFile: resolve(homedir(), ".config", "pi-mobile-gateway", "devices.json"),
		help: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const next = (): string | undefined => argv[++i];
		switch (arg) {
			case "--help":
			case "-h": {
				options.help = true;
				break;
			}
			case "--data-port": {
				const value = Number(next());
				if (!Number.isInteger(value) || value <= 0 || value > 65535) return { error: "--data-port 需要有效端口" };
				options.dataPort = value;
				break;
			}
			case "--bind": {
				const value = next();
				if (!value) return { error: "--bind 需要地址" };
				options.bindHost = value;
				break;
			}
			case "--mgmt-port": {
				const value = Number(next());
				if (!Number.isInteger(value) || value <= 0 || value > 65535) return { error: "--mgmt-port 需要有效端口" };
				options.mgmtPort = value;
				break;
			}
			case "--device-file": {
				const value = next();
				if (!value) return { error: "--device-file 需要路径" };
				options.deviceFile = resolve(value);
				break;
			}
			case "--session-dir": {
				const value = next();
				if (!value) return { error: "--session-dir 需要路径" };
				options.sessionDir = resolve(value);
				break;
			}
			case "--public-url": {
				const value = next();
				if (!value) return { error: "--public-url 需要 URL" };
				options.publicUrl = value;
				break;
			}
			case "--pair": {
				const value = next();
				options.pairName = value && value !== "" ? value : "未命名设备";
				break;
			}
			default:
				return { error: `未知选项: ${arg}` };
		}
	}
	return options;
}

/** 只推断私网 IPv4；公网网卡不能被当作明文配对入口。 */
function detectLanIp(): string | undefined {
	for (const interfaces of Object.values(networkInterfaces())) {
		for (const info of interfaces ?? []) {
			if (info.family === "IPv4" && !info.internal && isPrivateNetworkHostname(info.address)) return info.address;
		}
	}
	return undefined;
}

function main(): void {
	const parsed = parseArgs(process.argv.slice(2));
	if ("error" in parsed) {
		console.error(parsed.error);
		console.error(usage());
		process.exit(2);
	}
	const options = parsed;
	if (options.help) {
		console.log(usage());
		return;
	}

	const lanIp = detectLanIp();
	const rawPublicUrl = options.publicUrl ?? (lanIp ? `ws://${lanIp}:${options.dataPort}/ws/mobile` : undefined);

	// 无 LAN 且未指定 URL 时先拒绝配对，避免回环兜底生成手机不可用的二维码。
	if (options.pairName !== undefined && rawPublicUrl === undefined) {
		console.error("无法生成配对码：未检测到局域网 IPv4，且未指定 --public-url。");
		console.error("请用 --public-url ws://<电脑IP>:<端口>/ws/mobile 显式指定手机可达地址。");
		process.exit(2);
	}

	// 与管理面共用地址校验，在打开监听和访问注册表前拒绝无效地址。
	// 未配对且无 LAN 时，管理面仍可使用校验器提供的回环兜底。
	const validated = normalizePublicUrl(rawPublicUrl, `ws://127.0.0.1:${options.dataPort}`, "/ws/mobile");
	if (!validated.ok) {
		console.error(`无效的 --public-url: ${validated.error}`);
		console.error("示例: --public-url ws://<私网IP>:<端口>/ws/mobile 或 wss://<公网域名>/ws/mobile");
		process.exit(2);
	}
	const publicUrl = validated.url;

	const registry = createRegistry(options.deviceFile);
	// provider 测试状态与激活判定共用同一份存储：测试结果落盘，listModels/菜单
	// 据此过滤（"测过且连不通"的 provider 灰显且模型不进菜单）。路径与设备注册表同目录。
	const providerStatusStore = new ProviderStatusStore(resolve(dirname(options.deviceFile), "provider-status.json"));
	const runtime = new PiRuntime({
		sessionDir: options.sessionDir,
		log: (message) => console.error(`[pi] ${message}`),
		providerActive: (providerId) => providerStatusStore.isActive(providerId),
	});

	const dataPlanePromise = startDataPlane({
		registry,
		port: options.dataPort,
		host: options.bindHost,
		log: (message) => console.error(`[ws] ${message}`),
		onClient: (send) =>
			connectClient(runtime, send, {
				log: (message) => console.error(`[router] ${message}`),
				providerStatusStore,
			}),
	});
	const mgmtPlanePromise = startMgmtPlane({
		registry,
		port: options.mgmtPort,
		dataPort: options.dataPort,
		publicUrl: () => publicUrl ?? `ws://127.0.0.1:${options.dataPort}/ws/mobile`,
	});

	Promise.all([dataPlanePromise, mgmtPlanePromise])
		.then(([dataPlane, mgmtPlane]) => {
			console.log("pi-mobile-gateway 已启动");
			console.log(
				options.bindHost
					? `  数据面 (WebSocket): ws://${options.bindHost}:${dataPlane.port}/ws/mobile (仅绑定该地址)`
					: `  数据面 (WebSocket): ws://<本机IP>:${dataPlane.port}/ws/mobile (0.0.0.0 全部网卡)`,
			);
			if (lanIp) console.log(`  局域网地址推断:     ws://${lanIp}:${dataPlane.port}/ws/mobile`);
			else console.log("  (未检测到局域网 IPv4，手机与电脑需同网段或手动指定 --public-url)");
			console.log(`  管理面 (localhost): http://127.0.0.1:${mgmtPlane.port}/mgw/status`);
			console.log(`  设备注册表:         ${options.deviceFile}`);
			console.log(`  pi 会话目录:        ${options.sessionDir ?? "(跟随 pi 默认: ~/.pi/agent/sessions)"}`);
			console.log("  已配对设备: %d", registry.count());

			if (options.pairName) {
				const pairing = registry.createPairing(options.pairName);
				const payload = {
					version: 1,
					publicUrl: publicUrl ?? `ws://127.0.0.1:${dataPlane.port}/ws/mobile`,
					pairingCode: pairing.code,
					expiresAt: pairing.expiresAt,
				};
				console.log("");
				console.log(
					`为「${pairing.name}」生成配对码，${new Date(pairing.expiresAt).toLocaleTimeString()} 过期，仅可使用一次:`,
				);
				console.log("");
				qrcode.generate(encodePairingText(payload), { small: true });
				console.log("");
				console.log("手动输入用文本:");
				console.log(encodePairingText(payload));
			}

			const shutdown = () => {
				console.log("正在关闭…");
				Promise.all([dataPlane.close(), mgmtPlane.close()])
					.then(() => {
						runtime.disposeAll();
						process.exit(0);
					})
					.catch(() => process.exit(1));
			};
			process.on("SIGINT", shutdown);
			process.on("SIGTERM", shutdown);
		})
		.catch((error: unknown) => {
			// Port in use and similar startup failures must not crash with an
			// unhandled rejection.
			console.error(`启动失败: ${(error as Error).message ?? error}`);
			process.exit(1);
		});
}

main();
