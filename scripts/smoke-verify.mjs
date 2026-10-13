#!/usr/bin/env node
// End-to-end smoke check against a running pi-mobile-gateway.
//
// Usage: node scripts/smoke-verify.mjs [--mgmt-port 3083] [--prompt]
//
// Requires `ws` from the repo's node_modules; run from the repo root with the
// gateway already up (see AGENTS.md 手工 smoke). --prompt additionally sends
// one real message to a new session, which calls the configured model once.

import { mkdtempSync } from "node:fs";
import { connect as connectNet } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import WebSocket from "ws";

function arg(name, fallback) {
	const index = process.argv.indexOf(`--${name}`);
	if (index < 0 || index + 1 >= process.argv.length) return fallback;
	const value = process.argv[index + 1];
	return value.startsWith("--") ? fallback : value;
}

function flag(name) {
	return process.argv.includes(`--${name}`);
}

const mgmtPort = Number(arg("mgmt-port", 3083));
const doPrompt = flag("prompt");
let failures = 0;

function check(label, ok, detail = "") {
	if (ok) console.log(`${label}: OK${detail ? ` (${detail})` : ""}`);
	else {
		failures++;
		console.error(`${label}: FAIL${detail ? ` (${detail})` : ""}`);
	}
}

function post(path, body, headers = {}) {
	return fetch(`http://127.0.0.1:${mgmtPort}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify(body),
	});
}

// Malformed request line must not kill the process; find the data port first.
const status = await fetch(`http://127.0.0.1:${mgmtPort}/mgw/status`).then((r) => r.json());
const dataPort = status.dataPort;
check("mgmt status", Number.isInteger(dataPort), `dataPort=${dataPort}`);

function rawRequest(port, payload) {
	return new Promise((resolve) => {
		const socket = connectNet(port);
		let response = "";
		const finish = () => {
			socket.destroy();
			resolve(response);
		};
		socket.on("data", (chunk) => {
			response += chunk.toString("utf8");
			if (response.includes("\r\n")) finish();
		});
		socket.setTimeout(2000, finish);
		socket.on("error", finish);
		socket.write(payload);
	});
}

const malformed = await rawRequest(dataPort, "GET http://[::1:80/x HTTP/1.1\r\n\r\n");
check("malformed request line rejected, process alive", /^HTTP\/1\.1 400/.test(malformed));

// Mint a pairing code and walk the full pairing → token → replay loop.
const pair = await post("/mgw/pair", {}).then((r) => r.json());
const payload = JSON.parse(Buffer.from(pair.pairingText, "base64url").toString("utf8"));
check("pairing payload decodes", typeof payload.pairingCode === "string", payload.publicUrl);

const open = (url, protocols, headers) =>
	new Promise((resolve) => {
		const ws = new WebSocket(url, protocols, { headers });
		const frames = [];
		ws.on("message", (data) => frames.push(JSON.parse(data.toString())));
		ws.on("open", () => resolve({ ws, frames }));
		ws.on("unexpected-response", (_req, res) => resolve({ status: res.statusCode }));
		ws.on("error", () => resolve({ status: "error" }));
	});

const first = await open(payload.publicUrl, ["pi-mobile-v1", `pi-pair.${payload.pairingCode}`], {
	"x-pi-device-id": "smoke-install-0001",
});
await new Promise((r) => setTimeout(r, 300));
const paired = first.frames?.find((f) => f.kind === "paired");
check("pairing handshake", Boolean(paired?.token), `device=${paired?.device?.name ?? "?"}`);
check(
	"hello after pairing",
	first.frames?.some((f) => f.kind === "hello" && f.authenticated === true),
);
first.ws?.close();

const second = await open(payload.publicUrl, ["pi-mobile-v1"], {
	authorization: `Bearer ${paired?.token ?? ""}`,
	"x-pi-device-id": "smoke-install-0001",
});
await new Promise((r) => setTimeout(r, 200));
check(
	"token reconnect",
	second.frames?.some((f) => f.kind === "hello"),
);
second.ws?.send(JSON.stringify({ type: "ping" }));
await new Promise((r) => setTimeout(r, 200));
check(
	"ping→pong",
	second.frames?.some((f) => f.kind === "pong"),
);

const replay = await open(payload.publicUrl, ["pi-mobile-v1", `pi-pair.${payload.pairingCode}`], {
	"x-pi-device-id": "smoke-install-0001",
});
check("pairing code replay rejected", replay.status === 401, `status=${replay.status}`);

// ---------------------------------------------------------------------------
// Phase 2: business frames (sessions / subscribe / history / state / message).
// All read-only except the optional --prompt check, which creates one new
// session and sends a single message to the configured model.
// ---------------------------------------------------------------------------

// Fresh connection with a fresh pairing (the first code was consumed).
const pair2 = await post("/mgw/pair", {}).then((r) => r.json());
const payload2 = JSON.parse(Buffer.from(pair2.pairingText, "base64url").toString("utf8"));
const phone = await open(payload2.publicUrl, ["pi-mobile-v1", `pi-pair.${payload2.pairingCode}`], {
	"x-pi-device-id": "smoke-install-0001",
});
await new Promise((r) => setTimeout(r, 300));
const phoneToken = phone.frames?.find((f) => f.kind === "paired")?.token;
check("second pairing for business frames", Boolean(phoneToken));

// Simple collect pattern: send a frame, wait, inspect the frames that arrived.
const send = (frame) => phone.ws?.send(JSON.stringify(frame));
let cursor = phone.frames.length;
const collect = async (ms = 600) => {
	await new Promise((r) => setTimeout(r, ms));
	const out = phone.frames.slice(cursor);
	cursor = phone.frames.length;
	return out;
};
const sendAwait = async (frame, ms = 600) => {
	send(frame);
	return collect(ms);
};

const sessionsFrame = (await sendAwait({ type: "sessions" })).find((f) => f.kind === "sessions");
check(
	"sessions listing",
	Boolean(sessionsFrame) && Array.isArray(sessionsFrame.items),
	sessionsFrame ? `${sessionsFrame.items.length} sessions` : "no frame",
);

const firstSession = sessionsFrame?.items?.[0];
if (firstSession) {
	const historyFrame = (await sendAwait({ type: "history", sessionId: firstSession.id, limit: 50 })).find(
		(f) => f.kind === "history",
	);
	check(
		"history page",
		Boolean(historyFrame) &&
			Array.isArray(historyFrame.messages) &&
			Array.isArray(historyFrame.entryIds) &&
			historyFrame.messages.length === historyFrame.entryIds.length,
		historyFrame ? `${historyFrame.messages.length} msgs, model=${historyFrame.model?.modelId ?? "?"}` : "no frame",
	);
	if (historyFrame?.hasMore && historyFrame.oldestEntryId) {
		const page2 = (
			await sendAwait({ type: "history", sessionId: firstSession.id, beforeEntryId: historyFrame.oldestEntryId })
		).find((f) => f.kind === "history");
		check("history paging cursor", Boolean(page2), page2 ? `${page2.messages.length} older msgs` : "no frame");
	}
	const stateFrame = (await sendAwait({ type: "state", sessionId: firstSession.id })).find((f) => f.kind === "state");
	check("state poll", Boolean(stateFrame), stateFrame ? `streaming=${stateFrame.isStreaming}` : "no frame");
} else {
	check("history page", true, "skipped: no sessions on this gateway");
}

const subscribed = (
	await sendAwait(firstSession ? { type: "subscribe", sessionId: firstSession.id } : { type: "ping" })
).find((f) => f.kind === "subscribed" || f.kind === "pong");
check("subscribe", firstSession === undefined || subscribed?.kind === "subscribed");
const unsubscribed = (
	await sendAwait(firstSession ? { type: "unsubscribe", sessionId: firstSession.id } : { type: "ping" })
).find((f) => f.kind === "unsubscribed" || f.kind === "pong");
check("unsubscribe", firstSession === undefined || unsubscribed?.kind === "unsubscribed");

// Validation errors stay client-facing.
const badFrames = await sendAwait({ type: "message" });
check(
	"message validation errors",
	badFrames.some((f) => f.kind === "error" && f.code === "bad-request"),
);
const unknownFrames = await sendAwait({ type: "dance" });
check("unknown command error", unknownFramesCheck(unknownFrames));

function unknownFramesCheck(frames) {
	return frames.some((f) => f.kind === "error" && f.code === "unknown-command");
}

if (doPrompt) {
	const cwd = mkdtempSync(join(tmpdir(), "pi-mgw-smoke-prompt-"));
	const collected = await sendAwait({ type: "message", cwd, text: "Reply with exactly: ok" }, 1500);
	const sent = collected.find((f) => f.kind === "sent");
	check(
		"message accepted (sent)",
		Boolean(sent),
		sent ? `sessionId=${sent.sessionId}` : JSON.stringify(collected.map((f) => f.kind)),
	);
	if (sent) {
		// Wait for the run to settle (agent_settled event) before reading history.
		let settled = collected.some((f) => f.kind === "event" && f.event?.type === "agent_settled");
		for (let i = 0; i < 60 && !settled; i++) {
			const more = await collect(1000);
			settled = more.some((f) => f.kind === "event" && f.event?.type === "agent_settled");
		}
		check("run settled event received", settled);
		const events = phone.frames.slice(0, cursor).filter((f) => f.kind === "event" && f.sessionId === sent.sessionId);
		const seqs = events.map((f) => f.seq);
		const monotonic = seqs.every((s, i) => i === 0 || s === seqs[i - 1] + 1);
		check("event seq monotonic from 1", seqs.length > 0 && seqs[0] === 1 && monotonic, `${seqs.length} events`);
		const historyAfter = (await sendAwait({ type: "history", sessionId: sent.sessionId })).find(
			(f) => f.kind === "history",
		);
		const roles = (historyAfter?.messages ?? []).map((m) => m.role);
		check(
			"history after prompt has user+assistant",
			roles.includes("user") && roles.includes("assistant"),
			roles.join(","),
		);
	}
}

// Revocation must close the live connection with 4003.
const closed = new Promise((resolve) => second.ws?.on("close", (code) => resolve(code)));
const revokeResponse = await post(`/mgw/devices/${paired?.device?.id ?? ""}/revoke`, {});
check("revoke via mgmt", revokeResponse.status === 200);
const closeCode = await Promise.race([closed, new Promise((r) => setTimeout(() => r("timeout"), 2000))]);
check("revoked connection closed 4003", closeCode === 4003, `code=${closeCode}`);

console.log(failures === 0 ? "\nsmoke 全部通过" : `\nsmoke 失败 ${failures} 项`);
process.exit(failures === 0 ? 0 : 1);
