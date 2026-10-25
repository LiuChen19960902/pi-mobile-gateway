import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Agent, EventSource, fetch } from "undici";

test("both gateway entrypoints install the HTTP runtime before SDK imports", () => {
	// 单测直接导入初始化模块不足以保护入口接线；删除入口导入也必须被打红。
	for (const [entry, first] of [
		["../src/main.ts", 'import "./http-runtime.ts";'],
		["../scripts/dev-fixture-gateway.ts", 'import "../src/http-runtime.ts";'],
	]) {
		const source = readFileSync(new URL(entry, import.meta.url), "utf8");
		const firstImport = source.split(/\r?\n/).find((line) => /^import\b/.test(line));
		assert.equal(firstImport, first, `${entry} must initialize HTTP before importing the SDK`);
	}
});

async function listen(server: Server): Promise<string> {
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server, dispatcher: Agent): Promise<void> {
	await dispatcher.destroy();
	server.closeAllConnections();
	await new Promise<void>((resolve) => server.close(() => resolve()));
}

test("undici rejects excessive content encodings without terminating the process", () => {
	// 旧实现即使捕获 fetch 拒绝，内部孤立流仍会让进程退出，因此隔离在子进程。
	const program = `
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { once } from "node:events";
import { setTimeout } from "node:timers/promises";
import { Agent, fetch } from "undici";
const sockets = new Set();
const server = createServer(socket => {
  sockets.add(socket);
  socket.on("error", () => {});
  socket.on("close", () => sockets.delete(socket));
  socket.once("data", () => socket.end(
    "HTTP/1.1 200 OK\\r\\nContent-Encoding: gzip, gzip, gzip, gzip, gzip, gzip\\r\\nContent-Length: 1\\r\\nConnection: close\\r\\n\\r\\n"
  ));
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const agent = new Agent();
try {
  await assert.rejects(fetch("http://127.0.0.1:" + server.address().port, {
    dispatcher: agent, signal: AbortSignal.timeout(1500)
  }), error => error instanceof TypeError && /content-encoding/i.test(error.cause?.message ?? ""));
  await setTimeout(100);
} finally {
  await agent.destroy();
  for (const socket of sockets) socket.destroy();
  await new Promise(resolve => server.close(resolve));
}
`;
	const result = spawnSync(process.execPath, ["--input-type=module", "-e", program], {
		cwd: fileURLToPath(new URL("..", import.meta.url)),
		timeout: 5000,
		encoding: "utf8",
		maxBuffer: 32 * 1024,
	});
	assert.equal(result.error, undefined);
	assert.equal(result.signal, null);
	assert.equal(result.status, 0, result.stderr);
});

test("undici enforces EventSource parser state limits with a small response", async () => {
	const payload = "data:\n".repeat(1025);
	assert.ok(Buffer.byteLength(payload) < 16 * 1024);
	const server = createServer((_request, response) => {
		response.writeHead(200, { "content-type": "text/event-stream" });
		response.write(payload);
	});
	const dispatcher = new Agent({ eventSource: { maxEventSize: 128 * 1024 }, maxResponseSize: 16 * 1024 });
	const url = await listen(server);
	const source = new EventSource(url, { node: { dispatcher } });
	let errors = 0;
	let messages = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await new Promise<void>((resolve, reject) => {
			timer = setTimeout(() => reject(new Error("EventSource did not enforce its parser state limit")), 2000);
			source.addEventListener("message", () => messages++);
			source.addEventListener("error", () => {
				errors++;
				resolve();
			});
		});
		assert.equal(source.readyState, EventSource.CLOSED);
		assert.equal(errors, 1);
		assert.equal(messages, 0);
	} finally {
		if (timer) clearTimeout(timer);
		source.close();
		await close(server, dispatcher);
	}
});

test("undici checks mixed-case SRI hashes and accepts matching content", async () => {
	const expected = "expected-content";
	const digest = createHash("sha256").update(expected).digest("base64");
	const server = createServer((request, response) =>
		response.end(request.url === "/good" ? expected : "changed-content"),
	);
	const dispatcher = new Agent();
	const url = await listen(server);
	try {
		await assert.rejects(
			fetch(`${url}/bad`, { dispatcher, integrity: `SHA256-${digest}` }),
			(error: unknown) =>
				error instanceof TypeError && error.cause instanceof Error && /integrity mismatch/i.test(error.cause.message),
		);
		const response = await fetch(`${url}/good`, { dispatcher, integrity: `Sha256-${digest}` });
		assert.equal(await response.text(), expected);
	} finally {
		await close(server, dispatcher);
	}
});

test("gateway startup replaces vulnerable built-in HTTP globals", () => {
	const program = `
import "./src/http-runtime.ts";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { once } from "node:events";
import { setTimeout } from "node:timers/promises";
import { fetch, EventSource, Headers, Request, Response, getGlobalDispatcher } from "undici";
assert.equal(globalThis.fetch, fetch);
assert.equal(globalThis.EventSource, EventSource);
assert.equal(globalThis.Headers, Headers);
assert.equal(globalThis.Request, Request);
assert.equal(globalThis.Response, Response);
const sockets = new Set();
const server = createServer(socket => {
  sockets.add(socket);
  socket.on("error", () => {});
  socket.on("close", () => sockets.delete(socket));
  socket.once("data", () => socket.end(
    "HTTP/1.1 200 OK\\r\\nContent-Encoding: gzip, gzip, gzip, gzip, gzip, gzip\\r\\nContent-Length: 1\\r\\nConnection: close\\r\\n\\r\\n"
  ));
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
try {
  await assert.rejects(globalThis.fetch("http://127.0.0.1:" + server.address().port, {
    signal: AbortSignal.timeout(1500)
  }), error => error instanceof TypeError && /content-encoding/i.test(error.cause?.message ?? ""));
  await setTimeout(100);
} finally {
  await getGlobalDispatcher().destroy();
  for (const socket of sockets) socket.destroy();
  await new Promise(resolve => server.close(resolve));
}
`;
	const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", program], {
		cwd: fileURLToPath(new URL("..", import.meta.url)),
		timeout: 5000,
		encoding: "utf8",
		maxBuffer: 32 * 1024,
	});
	assert.equal(result.error, undefined);
	assert.equal(result.signal, null);
	assert.equal(result.status, 0, result.stderr);
});
