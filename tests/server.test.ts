// Integration tests for the data-plane WebSocket handshake. These run against
// a real loopback listener; they use only the local machine, no pi and no
// external network.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { connect as connectNet } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import WebSocket, { type ClientOptions } from "ws";
import { createRegistry, type DeviceRegistry } from "../src/devices.ts";
import { startMgmtPlane } from "../src/mgmt.ts";
import { type DataPlane, MAX_SEND_BUFFER_BYTES, sendFrame, startDataPlane } from "../src/server.ts";
import { CLIENT_FRAME_TYPES } from "../src/wire.ts";

const dirs: string[] = [];
const planes: Array<{ close: () => Promise<void> }> = [];

function tempDeviceFile(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-mgw-server-"));
	dirs.push(dir);
	return join(dir, "devices.json");
}

after(async () => {
	for (const plane of planes) await plane.close();
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

interface Planes {
	registry: DeviceRegistry;
	dataPlane: DataPlane;
	mgmtPort: number;
	baseUrl: string;
	mgmtUrl: (path: string) => string;
}

async function startPlanes(registryOptions: { now?: () => number; pairingTtlMs?: number } = {}): Promise<Planes> {
	const registry = createRegistry(tempDeviceFile(), registryOptions);
	const dataPlane = await startDataPlane({ registry, port: 0, host: "127.0.0.1" });
	const mgmtPlane = await startMgmtPlane({
		registry,
		port: 0,
		dataPort: dataPlane.port,
		publicUrl: () => `ws://127.0.0.1:${dataPlane.port}/ws/mobile`,
	});
	planes.push(dataPlane);
	planes.push(mgmtPlane);
	return {
		registry,
		dataPlane,
		mgmtPort: mgmtPlane.port,
		baseUrl: `ws://127.0.0.1:${dataPlane.port}/ws/mobile`,
		mgmtUrl: (path: string) => `http://127.0.0.1:${mgmtPlane.port}${path}`,
	};
}

interface TestClient {
	opened: boolean;
	status?: number;
	ws?: WebSocket;
	protocol?: string;
	/** Sends a frame; throws if the connection never opened. */
	send(data: string | Buffer): void;
	/** Resolves the next buffered or incoming JSON frame. */
	nextMessage(timeoutMs?: number): Promise<Record<string, unknown>>;
}

function connect(url: string, options: ClientOptions & { protocols?: string[] }): Promise<TestClient> {
	return new Promise((resolve) => {
		const { protocols, ...clientOptions } = options;
		const ws = new WebSocket(url, protocols ?? [], clientOptions);
		// Attach the message pipeline immediately: the server sends its first
		// frames the instant the upgrade completes, before an "open" handler
		// could attach a listener, and undelivered events would be dropped.
		const buffered: Array<Record<string, unknown>> = [];
		const waiters: Array<(frame: Record<string, unknown>) => void> = [];
		ws.on("message", (data) => {
			let frame: Record<string, unknown>;
			try {
				frame = JSON.parse(data.toString("utf8")) as Record<string, unknown>;
			} catch {
				return;
			}
			const waiter = waiters.shift();
			if (waiter) waiter(frame);
			else buffered.push(frame);
		});
		const nextMessage = (timeoutMs = 2_000): Promise<Record<string, unknown>> =>
			new Promise((resolveWaiter, rejectWaiter) => {
				const pending = buffered.shift();
				if (pending) {
					resolveWaiter(pending);
					return;
				}
				const timer = setTimeout(() => rejectWaiter(new Error("timed out waiting for frame")), timeoutMs);
				waiters.push((frame) => {
					clearTimeout(timer);
					resolveWaiter(frame);
				});
			});
		const send = (data: string | Buffer): void => {
			if (!ws) throw new Error("connection not open");
			ws.send(data);
		};
		let settled = false;
		const finish = (client: TestClient) => {
			if (settled) return;
			settled = true;
			resolve(client);
		};
		ws.on("open", () => finish({ opened: true, ws, protocol: ws.protocol, send, nextMessage }));
		ws.on("unexpected-response", (_request, response) =>
			finish({ opened: false, status: response.statusCode, send, nextMessage }),
		);
		ws.on("error", () => finish({ opened: false, send, nextMessage }));
	});
}

/** Sends raw bytes to a TCP port and collects whatever comes back. */
function rawHttp(port: number, payload: string, timeoutMs = 2_000): Promise<string> {
	return new Promise((resolve, rejectPromise) => {
		const socket = connectNet(port);
		let response = "";
		const finish = () => {
			socket.destroy();
			resolve(response);
		};
		const timer = setTimeout(finish, timeoutMs);
		socket.on("data", (chunk) => {
			response += chunk.toString("utf8");
			// We only need the status line.
			if (response.includes("\r\n")) {
				clearTimeout(timer);
				finish();
			}
		});
		socket.on("error", (error) => {
			clearTimeout(timer);
			rejectPromise(error);
		});
		socket.write(payload);
	});
}

describe("data plane: rejected upgrades", () => {
	it("rejects unauthenticated upgrades with HTTP 401", async () => {
		const { baseUrl } = await startPlanes();
		const result = await connect(baseUrl, {});
		assert.equal(result.opened, false);
		assert.equal(result.status, 401);
	});

	it("rejects an invalid long-lived token with HTTP 401", async () => {
		const { baseUrl } = await startPlanes();
		const result = await connect(baseUrl, { headers: { authorization: `Bearer ${"x".repeat(43)}` } });
		assert.equal(result.opened, false);
		assert.equal(result.status, 401);
	});

	it("rejects a wrong path with HTTP 404", async () => {
		const { baseUrl } = await startPlanes();
		const result = await connect(`${baseUrl}x`, {});
		assert.equal(result.opened, false);
		assert.equal(result.status, 404);
	});

	it("answers plain HTTP requests with 404", async () => {
		const { dataPlane } = await startPlanes();
		const response = await fetch(`http://127.0.0.1:${dataPlane.port}/`);
		assert.equal(response.status, 404);
	});

	it("rejects pairing without X-Pi-Device-ID with HTTP 400", async () => {
		const { baseUrl, registry } = await startPlanes();
		const pairing = registry.createPairing("手机");
		const result = await connect(baseUrl, {
			protocols: ["pi-mobile-v1", `pi-pair.${pairing.code}`],
			headers: {},
		});
		assert.equal(result.opened, false);
		assert.equal(result.status, 400);
	});
});

describe("data plane: pairing and authenticated session", () => {
	it("exchanges a one-time pairing code for a long-lived token, then reconnects", async (t) => {
		const { baseUrl, registry, dataPlane } = await startPlanes();
		const pairing = registry.createPairing("测试手机");

		// First connect: pairing via subprotocol, with the installation header.
		const first = await connect(baseUrl, {
			protocols: ["pi-mobile-v1", `pi-pair.${pairing.code}`],
			headers: { "x-pi-device-id": "install-0001" },
		});
		assert.ok(first.opened, `pairing failed with status ${first.status}`);
		assert.equal(first.protocol, "pi-mobile-v1");
		t.after(() => first.ws?.close());

		const pairedFrame = (await first.nextMessage()) as {
			kind: string;
			token: string;
			device?: { id: string };
		};
		assert.equal(pairedFrame.kind, "paired");
		const token = pairedFrame.token;
		assert.match(token, /^[A-Za-z0-9_-]{43}$/);
		const helloAfterPairing = await first.nextMessage();
		assert.equal(helloAfterPairing.kind, "hello");
		assert.equal(helloAfterPairing.authenticated, true);

		// Reconnect with the long-lived token via the Authorization header.
		const second = await connect(baseUrl, {
			protocols: ["pi-mobile-v1"],
			headers: { authorization: `Bearer ${token}`, "x-pi-device-id": "install-0001" },
		});
		assert.ok(second.opened, `token connect failed with status ${second.status}`);
		t.after(() => second.ws?.close());

		const hello = await second.nextMessage();
		assert.equal(hello.kind, "hello");
		assert.deepEqual(hello.device, { id: pairedFrame.device?.id, name: "测试手机" });
		assert.equal(hello.clients, 2);

		// The one-time code is consumed.
		const replay = await connect(baseUrl, {
			protocols: ["pi-mobile-v1", `pi-pair.${pairing.code}`],
			headers: { "x-pi-device-id": "install-0001" },
		});
		assert.equal(replay.opened, false);
		assert.equal(replay.status, 401);

		// ping -> pong
		second.send(JSON.stringify({ type: "ping", pingId: "measurement-1" }));
		const pong = await second.nextMessage();
		assert.equal(pong.kind, "pong");
		assert.equal(pong.pingId, "measurement-1");
		assert.equal(typeof pong.at, "number");

		// Unknown frame -> error
		second.send(JSON.stringify({ type: "definitely-not-a-command" }));
		const error = await second.nextMessage();
		assert.equal(error.kind, "error");
		assert.equal(error.code, "unknown-command");

		// Binary frame -> error
		second.send(Buffer.from("00"));
		const binaryError = await second.nextMessage();
		assert.equal(binaryError.code, "bad-request");

		// Invalid JSON -> error
		second.send("not json");
		const jsonError = await second.nextMessage();
		assert.equal(jsonError.code, "bad-request");

		assert.equal(dataPlane.connectedClients(), 2);
	});

	it("re-pairing the same installation rotates the token", async (t) => {
		const { baseUrl, registry } = await startPlanes();
		const first = await connect(baseUrl, {
			protocols: ["pi-mobile-v1", `pi-pair.${registry.createPairing("手机").code}`],
			headers: { "x-pi-device-id": "install-0002" },
		});
		assert.ok(first.opened);
		t.after(() => first.ws?.close());
		const firstPaired = await first.nextMessage();
		const firstToken = String(firstPaired.token);

		const second = await connect(baseUrl, {
			protocols: ["pi-mobile-v1", `pi-pair.${registry.createPairing("手机2").code}`],
			headers: { "x-pi-device-id": "install-0002" },
		});
		assert.ok(second.opened);
		t.after(() => second.ws?.close());
		const secondPaired = await second.nextMessage();
		assert.notEqual(secondPaired.token, firstToken);

		const oldTokenConnect = await connect(baseUrl, {
			protocols: ["pi-mobile-v1"],
			headers: { authorization: `Bearer ${firstToken}` },
		});
		assert.equal(oldTokenConnect.opened, false);
		assert.equal(oldTokenConnect.status, 401);

		const newTokenConnect = await connect(baseUrl, {
			protocols: ["pi-mobile-v1"],
			headers: { authorization: `Bearer ${secondPaired.token}` },
		});
		assert.ok(newTokenConnect.opened);
		t.after(() => newTokenConnect.ws?.close());
	});

	it("rejects an expired pairing code with HTTP 401", async () => {
		let clock = 1_000_000_000_000;
		const { baseUrl, registry } = await startPlanes({ now: () => clock, pairingTtlMs: 60_000 });
		const code = registry.createPairing("手机").code;
		clock += 120_000; // 超过 TTL，配对码过期
		const result = await connect(baseUrl, {
			protocols: ["pi-mobile-v1", `pi-pair.${code}`],
			headers: { "x-pi-device-id": "install-expired" },
		});
		assert.equal(result.opened, false);
		assert.equal(result.status, 401);
	});

	it("pairs through the query-string compatibility path", async (t) => {
		const { baseUrl, registry } = await startPlanes();
		const pairing = registry.createPairing("手机");
		const client = await connect(`${baseUrl}?pairingCode=${pairing.code}`, {
			headers: { "x-pi-device-id": "install-query" },
		});
		assert.ok(client.opened, `query pairing failed with status ${client.status}`);
		t.after(() => client.ws?.close());
		const paired = await client.nextMessage();
		assert.equal(paired.kind, "paired");
		const hello = await client.nextMessage();
		assert.equal(hello.kind, "hello");
	});

	it("closes a revoked device's live connections with close code 4003", async (t) => {
		const { baseUrl, registry } = await startPlanes();
		const pairing = registry.createPairing("手机");
		const client = await connect(baseUrl, {
			protocols: ["pi-mobile-v1", `pi-pair.${pairing.code}`],
			headers: { "x-pi-device-id": "install-revoke" },
		});
		assert.ok(client.opened);
		const paired = (await client.nextMessage()) as { device?: { id: string } };
		const closed = new Promise<{ code: number; reason: string }>((resolve) => {
			client.ws?.on("close", (code, reason) => resolve({ code, reason: reason.toString() }));
		});
		t.after(() => client.ws?.close());

		assert.equal(registry.revoke(paired.device?.id ?? ""), true);
		const closeInfo = await closed;
		assert.equal(closeInfo.code, 4003);
		assert.equal(closeInfo.reason, "device revoked");
	});
});

describe("data plane: robustness", () => {
	it("survives a malformed request line and keeps serving", async () => {
		const { baseUrl, dataPlane } = await startPlanes();
		// Absolute-form URL with a broken IPv6 literal: must not escape the
		// upgrade handler as an uncaught exception (process-killing DoS).
		const response = await rawHttp(dataPlane.port, "GET http://[::1:80/x HTTP/1.1\r\n\r\n");
		assert.match(response, /^HTTP\/1\.1 400 Bad Request/);
		// The process is still alive and upgrades normally.
		const probe = await connect(baseUrl, {});
		assert.equal(probe.opened, false);
		assert.equal(probe.status, 401);
	});

	it("closes the connection with 1009 on frames above 18 MiB", async (t) => {
		const { baseUrl, registry } = await startPlanes();
		const pairing = registry.createPairing("手机");
		const client = await connect(baseUrl, {
			protocols: ["pi-mobile-v1", `pi-pair.${pairing.code}`],
			headers: { "x-pi-device-id": "install-oversize" },
		});
		assert.ok(client.opened);
		t.after(() => client.ws?.close());
		const closed = new Promise<number>((resolve) => {
			client.ws?.on("close", (code) => resolve(code));
		});
		client.send(JSON.stringify({ type: "ping", pad: "a".repeat(19 * 1024 * 1024) }));
		assert.equal(await closed, 1009);
	});

	it("terminates instead of buffering when the client stops reading", async () => {
		const sent: string[] = [];
		let terminated = 0;
		const logs: string[] = [];
		const stalled = {
			bufferedAmount: MAX_SEND_BUFFER_BYTES,
			send: (payload: string) => void sent.push(payload),
			terminate: () => void terminated++,
		};
		sendFrame(stalled, { kind: "pong", at: 0 }, (message) => logs.push(message));
		assert.equal(terminated, 1);
		assert.deepEqual(sent, []);
		assert.match(logs.join("\n"), /backpressure/);
	});

	it("sends normally while the buffer is below the limit", async () => {
		const sent: string[] = [];
		let terminated = 0;
		const healthy = {
			bufferedAmount: 0,
			send: (payload: string) => void sent.push(payload),
			terminate: () => void terminated++,
		};
		sendFrame(healthy, { kind: "pong", at: 1 });
		assert.equal(terminated, 0);
		assert.equal(sent.length, 1);
		assert.ok(sent[0].includes('"kind":"pong"'));
	});
});

describe("management plane", () => {
	it("mints pairing payloads and lists/revokes devices", async () => {
		const { registry, mgmtUrl, baseUrl } = await startPlanes();

		const pairResponse = await fetch(mgmtUrl("/mgw/pair"), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ name: "测试手机" }),
		});
		assert.equal(pairResponse.status, 201);
		const pairBody = (await pairResponse.json()) as { pairingText: string };
		assert.match(pairBody.pairingText, /^[A-Za-z0-9_-]+$/);

		// Without a body override the minted URL must be the configured one, not
		// a hardcoded localhost address (a phone on Tailscale cannot use that).
		const decoded = JSON.parse(Buffer.from(pairBody.pairingText, "base64url").toString("utf8")) as {
			publicUrl: string;
		};
		assert.equal(decoded.publicUrl, baseUrl);

		const claimed = registry.claimPairing(registry.createPairing("手机").code, "install-0001");
		assert.ok(claimed);

		const statusResponse = await fetch(mgmtUrl("/mgw/status"));
		assert.equal(statusResponse.status, 200);
		const status = (await statusResponse.json()) as { devices: unknown[] };
		assert.equal(status.devices.length, 1);

		const devicesResponse = await fetch(mgmtUrl("/mgw/devices"));
		const devices = (await devicesResponse.json()) as { devices: Array<{ name: string }> };
		assert.equal(devices.devices.length, 1);
		assert.equal(devices.devices[0]?.name, "手机");

		const revokeResponse = await fetch(mgmtUrl(`/mgw/devices/${claimed.device.id}/revoke`), {
			method: "POST",
			headers: { "content-type": "application/json" },
		});
		assert.equal(revokeResponse.status, 200);

		const bareRevoke = await fetch(mgmtUrl("/mgw/devices/nonexistent/revoke"), { method: "POST" });
		assert.equal(bareRevoke.status, 415);
		const afterRevoke = (await (await fetch(mgmtUrl("/mgw/devices"))).json()) as { devices: unknown[] };
		assert.equal(afterRevoke.devices.length, 0);
	});

	it("rejects unknown routes and non-JSON bodies", async () => {
		const { mgmtUrl } = await startPlanes();
		assert.equal((await fetch(mgmtUrl("/mgw/nope"))).status, 404);
		const bad = await fetch(mgmtUrl("/mgw/pair"), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{not json",
		});
		assert.equal(bad.status, 400);
	});

	it("rejects cross-origin and non-allow-listed Host requests", async () => {
		const { mgmtUrl, mgmtPort } = await startPlanes();
		// Cross-origin browser request (CSRF shape).
		const csrf = await fetch(mgmtUrl("/mgw/pair"), {
			method: "POST",
			headers: { "content-type": "application/json", origin: "http://evil.example.com" },
			body: "{}",
		});
		assert.equal(csrf.status, 403);
		// Forged Host (DNS rebinding shape).
		const rebinding = await rawHttp(
			mgmtPort,
			"POST /mgw/pair HTTP/1.1\r\nHost: evil.example.com\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}",
		);
		assert.match(rebinding, /^HTTP\/1\.1 403/);
	});

	it("requires an application/json Content-Type on POST (blocks CORS simple requests)", async () => {
		const { mgmtUrl } = await startPlanes();
		const simple = await fetch(mgmtUrl("/mgw/pair"), {
			method: "POST",
			headers: { "content-type": "text/plain" },
			body: "{}",
		});
		assert.equal(simple.status, 415);
	});

	it("rejects oversized bodies with 413", async () => {
		const { mgmtUrl } = await startPlanes();
		const response = await fetch(mgmtUrl("/mgw/pair"), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ name: "x".repeat(70 * 1024) }),
		});
		assert.equal(response.status, 413);
	});

	it("validates publicUrl before minting a pairing payload", async () => {
		const { mgmtUrl } = await startPlanes();
		const plaintextPublic = await fetch(mgmtUrl("/mgw/pair"), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ publicUrl: "ws://gateway.example.com/ws/mobile" }),
		});
		assert.equal(plaintextPublic.status, 400);
		const ok = await fetch(mgmtUrl("/mgw/pair"), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ publicUrl: "wss://gateway.example.com/ws/mobile" }),
		});
		assert.equal(ok.status, 201);
	});
});

describe("hello capabilities advertisement", () => {
	it("advertises the full business + workspace picker capability set", async (t) => {
		const registry = createRegistry(tempDeviceFile());
		const dataPlane = await startDataPlane({
			registry,
			port: 0,
			host: "127.0.0.1",
			onClient: () => ({ handleMessage: async () => {}, close: () => {} }),
		});
		planes.push(dataPlane);

		const pairing = registry.createPairing("能力测试");
		const client = await connect(`ws://127.0.0.1:${dataPlane.port}/ws/mobile`, {
			protocols: ["pi-mobile-v1", `pi-pair.${pairing.code}`],
			headers: { "x-pi-device-id": "install-capabilities" },
		});
		assert.ok(client.opened, `connect failed: ${client.status}`);
		t.after(() => client.ws?.close());
		const paired = await client.nextMessage();
		assert.equal(paired.kind, "paired");
		const hello = await client.nextMessage();
		assert.equal(hello.kind, "hello");
		// 与 ClientFrameType 全量比对（而不是抄一份清单）：新增帧类型却忘了宣告
		// capabilities 时，这条断言必须失败。
		const advertised = hello.capabilities as string[];
		assert.equal(new Set(advertised).size, advertised.length, "capabilities 不得有重复项");
		assert.deepEqual(
			[...advertised].sort(),
			[
				...CLIENT_FRAME_TYPES,
				"tree-view-v1",
				"tree-actions-v1",
				"worktree-v1",
				"history-turns-v1",
				"provider-catalog-v1",
				"ping-id",
				"model-scope-v1",
				"provider-model-base-url-v1",
				"provider-test-id-v1",
				"prompt-disposition-v1",
				"extension-status",
			].sort(),
			"capabilities 必须与 ClientFrameType 全量一致",
		);
	});
});
