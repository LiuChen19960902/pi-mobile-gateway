// Management plane: a localhost-only HTTP JSON API for the desktop side
// (terminal, TUI companion extension, future WebUI panel).
//
// It binds 127.0.0.1 by construction and never to the LAN: pairing codes are
// minted here, devices listed and revoked here. Anyone who can reach this
// listener owns the machine already.
//
// Defense against browser-based attackers (CSRF / DNS rebinding), ported from
// dsh-plugin-mobile-gateway: requests must carry an allow-listed Host, must be
// same-origin when an Origin header is present, and state-changing POSTs must
// use an application/json Content-Type (which browsers cannot send without a
// CORS preflight).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import type { DeviceRegistry } from "./devices.ts";
import { isAllowedLocalHost, isSameOrigin, normalizePublicUrl } from "./net-guards.ts";
import { encodePairingText } from "./pairing.ts";

const MAX_BODY_BYTES = 64 * 1024;
const WS_PATH = "/ws/mobile";

export interface MgmtPlaneOptions {
	registry: DeviceRegistry;
	port: number;
	/** Where the data plane actually listens, reported by /mgw/status. */
	dataPort: number;
	/** Best-effort public data-plane URL, reported by /mgw/status. */
	publicUrl: () => string;
}

export interface MgmtPlane {
	server: Server;
	port: number;
	close(): Promise<void>;
}

class HttpError extends Error {
	status: number;

	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Cache-Control": "no-store",
		"Content-Length": Buffer.byteLength(payload),
	});
	res.end(payload);
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		let oversized = false;
		req.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > MAX_BODY_BYTES) oversized = true;
			else chunks.push(chunk);
		});
		req.on("end", () => {
			if (oversized) {
				reject(new HttpError(413, "request body is too large"));
				return;
			}
			if (chunks.length === 0) {
				resolve({});
				return;
			}
			try {
				const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
				if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
					reject(new HttpError(400, "body must be a JSON object"));
					return;
				}
				resolve(parsed as Record<string, unknown>);
			} catch {
				reject(new HttpError(400, "request body must be valid JSON"));
			}
		});
		req.on("error", (error) => reject(new HttpError(400, (error as Error).message || "request error")));
	});
}

export function startMgmtPlane(options: MgmtPlaneOptions): Promise<MgmtPlane> {
	const { registry } = options;
	const server: Server = createServer((req, res) => {
		handle(req, res).catch((error: unknown) => {
			if (error instanceof HttpError) {
				sendJson(res, error.status, { error: error.message });
				return;
			}
			// Never echo internal error details (FS paths etc.) to the client.
			sendJson(res, 500, { error: "internal error" });
		});
	});

	const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
		// Host allow-list: defeats DNS rebinding, where a public name resolves
		// to 127.0.0.1 and makes the attacker's page "same origin".
		if (!isAllowedLocalHost(req.headers.host)) {
			sendJson(res, 403, { error: "host not allowed" });
			return;
		}
		// Cross-origin browser requests are rejected even before routing.
		if (!isSameOrigin(req.headers)) {
			sendJson(res, 403, { error: "cross-origin request rejected" });
			return;
		}

		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		const path = url.pathname.replace(/\/+$/, "") || "/";
		const method = req.method ?? "GET";

		if (path === "/mgw/status" && method === "GET") {
			sendJson(res, 200, {
				dataPort: options.dataPort,
				publicUrl: options.publicUrl(),
				devices: registry.list(),
			});
			return;
		}

		if (path === "/mgw/pair" && method === "POST") {
			// JSON Content-Type only: browsers cannot issue a cross-origin POST
			// with this Content-Type without a preflight, which never passes.
			const contentType = req.headers["content-type"] ?? "";
			if (!String(contentType).toLowerCase().startsWith("application/json")) {
				sendJson(res, 415, { error: "content-type must be application/json" });
				return;
			}
			const body = await readJsonBody(req);
			if (body.name !== undefined && typeof body.name !== "string") {
				sendJson(res, 400, { error: "name must be a string" });
				return;
			}
			if (body.publicUrl !== undefined && typeof body.publicUrl !== "string") {
				sendJson(res, 400, { error: "publicUrl must be a string" });
				return;
			}
			// Validate before minting: the QR payload must never point somewhere
			// unsafe (e.g. plaintext ws:// to a public host). Absent an explicit
			// body override, use the *configured* public URL (--public-url /
			// detected LAN) — a hardcoded localhost default would hand out a QR
			// that only works next to the machine (e.g. over Tailscale).
			const normalized = normalizePublicUrl(
				body.publicUrl ?? options.publicUrl(),
				`ws://127.0.0.1:${options.dataPort}`,
				WS_PATH,
			);
			if (!normalized.ok) {
				sendJson(res, 400, { error: normalized.error });
				return;
			}
			const pairing = registry.createPairing(body.name);
			const payload = {
				version: 1,
				publicUrl: normalized.url,
				pairingCode: pairing.code,
				expiresAt: pairing.expiresAt,
			};
			sendJson(res, 201, {
				pairingText: encodePairingText(payload),
				payload,
				shortCode: pairing.shortCode,
				shortCodeExpiresAt: pairing.shortCodeExpiresAt,
			});
			return;
		}

		if (path === "/mgw/devices" && method === "GET") {
			sendJson(res, 200, { devices: registry.list() });
			return;
		}

		const revokeMatch = /^\/mgw\/devices\/([^/]+)\/revoke$/.exec(path);
		if (revokeMatch && method === "POST") {
			// 与 /mgw/pair 同口径：POST 须 application/json，否则 415。
			const contentType = req.headers["content-type"] ?? "";
			if (!String(contentType).toLowerCase().startsWith("application/json")) {
				sendJson(res, 415, { error: "content-type must be application/json" });
				return;
			}
			// The registry notifies the data plane via onRevoke, which closes
			// the revoked device's live connections with close code 4003.
			const ok = registry.revoke(decodeURIComponent(revokeMatch[1] ?? ""));
			sendJson(res, ok ? 200 : 404, ok ? { revoked: true } : { error: "device not found" });
			return;
		}

		sendJson(res, 404, { error: "not found" });
	};

	server.on("connection", (socket: Socket) => {
		// Defense in depth: this listener is bound to 127.0.0.1, and any
		// non-loopback connection that still reaches it is refused.
		const remote = socket.remoteAddress ?? "";
		if (remote !== "127.0.0.1" && remote !== "::1" && remote !== "::ffff:127.0.0.1") {
			socket.destroy();
		}
	});

	return new Promise((resolve, rejectPromise) => {
		server.once("error", rejectPromise);
		server.listen(options.port, "127.0.0.1", () => {
			const address = server.address();
			const port = typeof address === "object" && address !== null ? address.port : options.port;
			resolve({
				server,
				port,
				close: () =>
					new Promise<void>((resolveClose) => {
						server.close(() => resolveClose());
					}),
			});
		});
	});
}
