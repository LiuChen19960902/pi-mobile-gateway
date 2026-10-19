// Data plane: the WebSocket endpoint mobile clients connect to.
//
// The listener is separate from the localhost-only management plane so the
// security boundary is enforced by construction (two sockets), not by runtime
// checks on a shared socket. This listener serves exactly one path, /ws/mobile,
// accepts private-network clients only, and every upgrade must present a valid
// credential:
//   - 401: missing/invalid/expired/used-up credential
//   - 400: pairing attempt without the X-Pi-Device-ID installation header,
//          or a malformed request line/URL
//   - 403: non-private-network source address
//   - 404: any other path
//
// Revoking a device closes its live connections with close code 4003.
// On success the server sends `paired` (exactly once, pairing only) and then
// `hello`. `ping` frames are answered with `pong`.

import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Socket } from "node:net";
import { type WebSocket, WebSocketServer } from "ws";
import { extractCredential, SUBPROTOCOL } from "./credentials.ts";
import { type DeviceRegistry, normalizeClientDeviceId, type PublicDevice } from "./devices.ts";
import { isPrivateNetworkHostname } from "./net-guards.ts";
import type { ClientFrameType } from "./wire.ts";

export const PROTOCOL_VERSION = 1;
/** 与客户端图片总预算（16 MiB base64）对齐：message 帧整机可携带 4 张压缩图，
 * 帧上限抬高到 18 MiB 避免大图触发 ws 硬断连；数据面仅限私有网络 + token 认证。 */
const MAX_FRAME_BYTES = 18 * 1024 * 1024;

type UpgradeOutcome =
	| { kind: "paired"; device: PublicDevice; token: string }
	| { kind: "authenticated"; device: PublicDevice };

export interface DataPlaneOptions {
	registry: DeviceRegistry;
	port: number;
	host?: string;
	/** 连接生命周期日志（open/close/close code）：排查移动端断连时按设备 id 追踪。 */
	log?: (message: string) => void;
	/**
	 * Business-frame handler factory (phase 2+): called once per
	 * authenticated connection. When omitted only ping/pong is served.
	 */
	onClient?: (send: (frame: Record<string, unknown>) => void) => {
		handleMessage(frame: Record<string, unknown>): Promise<void>;
		close(): void;
	};
}

export interface DataPlane {
	server: Server;
	port: number;
	close(): Promise<void>;
	connectedClients(): number;
}

function reject(socket: Socket, status: number, message: string): void {
	const reason =
		status === 401 ? "Unauthorized" : status === 400 ? "Bad Request" : status === 403 ? "Forbidden" : "Not Found";
	socket.write(
		`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`,
	);
	socket.destroy();
}

/** 出站发送缓冲上限：客户端不读时直接断开而非无界堆积（OOM）。
 * 断开是安全降级：客户端重连走 catch-up 语义补回事件。日志在调用处给，
 * 纯函数无副作用以外的可测试性：export 供单测喂假 socket。 */
export const MAX_SEND_BUFFER_BYTES = 8 * 1024 * 1024;

export function sendFrame(
	ws: Pick<WebSocket, "bufferedAmount" | "send" | "terminate">,
	frame: Record<string, unknown>,
	log: (message: string) => void = () => {},
): void {
	const payload = JSON.stringify(frame);
	if (ws.bufferedAmount + Buffer.byteLength(payload, "utf8") > MAX_SEND_BUFFER_BYTES) {
		log(`ws backpressure: buffered=${ws.bufferedAmount} closing connection`);
		ws.terminate();
		return;
	}
	ws.send(payload);
}

export function startDataPlane(options: DataPlaneOptions): Promise<DataPlane> {
	const { registry } = options;
	const log = options.log ?? (() => {});
	const server = createServer((_req, res) => {
		// Plain HTTP on the data-plane listener: nothing to see here.
		res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
		res.end("Not Found");
	});
	const wss = new WebSocketServer({
		noServer: true,
		// Echo only the neutral version subprotocol, never the credential.
		handleProtocols: (protocols: Set<string>) => (protocols.has(SUBPROTOCOL) ? SUBPROTOCOL : false),
		maxPayload: MAX_FRAME_BYTES,
	});

	// Live connections per device, so revocation can enforce on open sockets.
	const connectionsByDevice = new Map<string, Set<WebSocket>>();
	registry.onRevoke((deviceId) => {
		const connections = connectionsByDevice.get(deviceId);
		if (!connections) return;
		for (const ws of connections) ws.close(4003, "device revoked");
		connectionsByDevice.delete(deviceId);
	});

	let boundPort = options.port;

	const upgrade = (req: IncomingMessage, socket: Socket, head: Buffer) => {
		// A malformed request line (e.g. an absolute-form URL with a broken IPv6
		// literal) must never escape this handler as an uncaught exception and
		// take down the whole process; the same guard also contains registry
		// save() failures during claim/authenticate.
		try {
			const url = new URL(req.url ?? "/", "http://localhost");
			if (url.pathname !== "/ws/mobile") {
				reject(socket, 404, "Not Found");
				return;
			}
			if (typeof socket.remoteAddress !== "string" || !isPrivateNetworkHostname(socket.remoteAddress)) {
				// 明文 ws 只接私网来源。但 Docker -p/端口映射的 DNAT 会把公网来访
				// 显示成网桥私网地址（如 172.17.0.1），来源检查此时看不见公网——
				// 不要把端口直接发布到公网，公网走 wss 反向代理，token 是最后一道。
				reject(socket, 403, "private-network clients only");
				return;
			}
			const credential = extractCredential(req.headers, url.searchParams);
			if (!credential) {
				reject(socket, 401, "Unauthorized");
				return;
			}
			const headerDeviceId = Array.isArray(req.headers["x-pi-device-id"])
				? req.headers["x-pi-device-id"][0]
				: req.headers["x-pi-device-id"];
			const clientDeviceId = normalizeClientDeviceId(headerDeviceId);
			let outcome: UpgradeOutcome;
			if (credential.kind === "pairing") {
				if (!clientDeviceId) {
					// Without a stable installation ID every reconnect would pair a new
					// device row, so refuse instead of accumulating duplicates.
					reject(socket, 400, "pairing requires X-Pi-Device-ID");
					return;
				}
				const paired = registry.claimPairing(credential.value, clientDeviceId);
				if (!paired) {
					reject(socket, 401, "Unauthorized");
					return;
				}
				outcome = { kind: "paired", device: paired.device, token: paired.token };
			} else {
				const device = registry.authenticate(credential.value, clientDeviceId);
				if (!device) {
					reject(socket, 401, "Unauthorized");
					return;
				}
				outcome = { kind: "authenticated", device };
			}
			const verified = outcome;
			wss.handleUpgrade(req, socket, head, (ws) => {
				log(`ws open: device=${verified.device.id.slice(0, 8)} kind=${verified.kind} remote=${socket.remoteAddress}`);
				connection(ws, verified);
			});
		} catch {
			reject(socket, 400, "Bad Request");
		}
	};

	const connection = (ws: WebSocket, outcome: UpgradeOutcome) => {
		try {
			if (!registry.connected(outcome.device.id)) {
				// Defense in depth for the authenticate→connected window; not
				// reachable through the current synchronous registry wiring.
				ws.close(1011, "device unavailable");
				return;
			}
			const connections = connectionsByDevice.get(outcome.device.id) ?? new Set<WebSocket>();
			connections.add(ws);
			connectionsByDevice.set(outcome.device.id, connections);
			if (outcome.kind === "paired") {
				// Sent exactly once: the client must persist this token itself.
				sendFrame(ws, { kind: "paired", token: outcome.token, device: outcome.device }, log);
			}
			sendFrame(
				ws,
				{
					kind: "hello",
					protocol: PROTOCOL_VERSION,
					authenticated: true,
					device: { id: outcome.device.id, name: outcome.device.name },
					port: boundPort,
					clients: wss.clients.size,
					// Feature advertisement so clients can detect what this
					// gateway serves (phase 2+: business frames; phase 1 only
					// ping/pong).
					capabilities: (options.onClient
						? [
								"ping",
								"sessions",
								"subscribe",
								"unsubscribe",
								"message",
								"prompt-disposition-v1",
								"abort",
								"dequeue",
								"history",
								"state",
								"models",
								"model-scope",
								"model-scope-put",
								"model-scope-v1",
								"provider-model-base-url-v1",
								"provider-test-id-v1",
								"set-model",
								"directories",
								"directory-create",
								"workspace-create",
								"providers",
								"provider-put",
								"provider-delete",
								"provider-test",
								"provider-models",
								"restart-session",
								"name",
								"compact",
								"commands",
								"input-resources",
								"input-completions",
								"tree",
								"tree-view-v1",
								"tree-actions-v1",
								"entry-copy",
								"label-put",
								"history-turns-v1",
								"provider-catalog-v1",
								"ping-id",
								"switch-branch",
								"worktree-v1",
								"worktree-list",
								"worktree-create",
								"worktree-continue",
								"worktree-status",
								"worktree-trust",
								"attachment",
							]
						: ["ping", "ping-id"]) satisfies (
						| ClientFrameType
						| "tree-view-v1"
						| "tree-actions-v1"
						| "worktree-v1"
						| "history-turns-v1"
						| "provider-catalog-v1"
						| "model-scope-v1"
						| "provider-model-base-url-v1"
						| "provider-test-id-v1"
						| "prompt-disposition-v1"
						| "ping-id"
					)[],
				},
				log,
			);
			ws.on("error", () => {
				// Protocol-level receiver errors (oversized frames, invalid UTF-8,
				// bad frame bits): ws has already initiated the appropriate close
				// (1009 etc.). Without this listener the error would escape as an
				// uncaught exception and kill the whole process.
			});
			const client = options.onClient?.((frame) => sendFrame(ws, frame, log));
			ws.on("message", (raw, isBinary) => {
				const data = Array.isArray(raw)
					? Buffer.concat(raw)
					: Buffer.isBuffer(raw)
						? raw
						: Buffer.from(raw as ArrayBuffer);
				if (isBinary) {
					log(`ws reject: binary frames are not supported`);
					sendFrame(ws, { kind: "error", code: "bad-request", message: "binary frames are not supported" }, log);
					return;
				}
				let frame: Record<string, unknown>;
				try {
					const parsed: unknown = JSON.parse(data.toString("utf8"));
					if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
						throw new Error("frame must be a JSON object");
					}
					frame = parsed as Record<string, unknown>;
				} catch {
					log(`ws reject: frame must be a JSON object`);
					sendFrame(ws, { kind: "error", code: "bad-request", message: "frame must be a JSON object" }, log);
					return;
				}
				if (frame.type === "ping") {
					sendFrame(
						ws,
						{
							kind: "pong",
							at: Date.now(),
							...(typeof frame.pingId === "string" && frame.pingId.length <= 128 ? { pingId: frame.pingId } : {}),
						},
						log,
					);
					return;
				}
				if (client) {
					// Business frames never take the process down; the router
					// converts every failure into an error frame.
					void client.handleMessage(frame).catch(() => {
						sendFrame(ws, { kind: "error", code: "internal", message: "internal error", requestType: "query" }, log);
					});
					return;
				}
				sendFrame(
					ws,
					{ kind: "error", code: "unknown-command", message: `unknown frame type: ${String(frame.type)}` },
					log,
				);
			});
			ws.on("close", (code, reason) => {
				log(
					`ws close: device=${outcome.device.id.slice(0, 8)} code=${code} reason=${reason.toString() || "-"} remaining=${wss.clients.size}`,
				);
				client?.close();
				const connections = connectionsByDevice.get(outcome.device.id);
				if (connections) {
					connections.delete(ws);
					if (connections.size === 0) connectionsByDevice.delete(outcome.device.id);
				}
				registry.disconnected(outcome.device.id);
			});
		} catch {
			// Never let a per-connection failure (e.g. registry save()) escape.
			ws.close(1011, "internal error");
		}
	};

	server.on("upgrade", upgrade);
	// Server-level socket errors must never escape as uncaught exceptions；但也
	// 绝不能因为一次 server 级错误把全部健康设备一起踢下线（单条连接的异常由
	// 下面的 ws.on("error") 兜底）。
	wss.on("error", (error) => {
		log(`data plane server error: ${error instanceof Error ? error.message : String(error)}`);
	});

	return new Promise((resolve, rejectPromise) => {
		server.once("error", rejectPromise);
		server.listen(options.port, options.host ?? "0.0.0.0", () => {
			const address = server.address();
			boundPort = typeof address === "object" && address !== null ? address.port : options.port;
			resolve({
				server,
				port: boundPort,
				connectedClients: () => wss.clients.size,
				close: () =>
					new Promise<void>((resolveClose) => {
						for (const client of wss.clients) client.terminate();
						wss.close(() => {
							server.close(() => resolveClose());
						});
					}),
			});
		});
	});
}
