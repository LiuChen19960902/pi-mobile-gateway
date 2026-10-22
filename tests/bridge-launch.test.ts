import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { it } from "node:test";
import { BridgeHub } from "../src/bridge.ts";
import { BridgeLaunchError, BridgeLauncher } from "../src/bridge-launch.ts";

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "pi-mgw-launch-"));
	const registry = join(root, "registry");
	mkdirSync(registry, { recursive: true });
	const bridge = new BridgeHub({ root });
	const extensionPath = join(root, "extension.ts");
	writeFileSync(extensionPath, "export {}\n");
	const sessionId = "11111111-2222-3333-4444-555555555555";
	const descriptor = {
		schema: 1,
		extensionVersion: "0.2.0",
		instanceId: "instance-1",
		epoch: "epoch-1",
		sessionId,
		pid: process.pid,
		socketPath: join(root, "missing.sock"),
		owner: true,
		startedAt: Date.now(),
		cwd: root,
		sessionFile: join(root, "session.jsonl"),
	};
	let execs = 0;
	const exec = async () => {
		execs++;
		writeFileSync(join(registry, `${sessionId}.json`), `${JSON.stringify(descriptor)}\n`);
	};
	const launcher = new BridgeLauncher({ root, bridge, exec, extensionPath, piBin: "fake-pi", tmuxBin: "fake-tmux" });
	return {
		root,
		sessionId,
		launcher,
		execCount: () => execs,
		input: (operationId: string, id = sessionId) => ({
			operationId,
			sessionId: id,
			sessionFile: join(root, "session.jsonl"),
			cwd: root,
		}),
	};
}

it("starts once, dedupes by operationId and live session", async () => {
	const f = fixture();
	const first = await f.launcher.launch(f.input("start-1"));
	assert.equal(first.duplicate, false);
	assert.equal(first.instanceId, "instance-1");
	assert.match(first.attachHint, /^pi-mobile attach /);
	assert.equal(f.execCount(), 1);

	const retry = await f.launcher.launch(f.input("start-1"));
	assert.equal(retry.duplicate, true);
	assert.equal(f.execCount(), 1);

	const otherOp = await f.launcher.launch(f.input("start-2"));
	assert.equal(otherOp.duplicate, true);
	assert.equal(f.execCount(), 1);
});

it("waits for one in-flight launch and rejects operation reuse for another session", async () => {
	const f = fixture();
	const pending = f.launcher.launch(f.input("start-1"));
	const second = await f.launcher.launch(f.input("start-2"));
	assert.equal(second.duplicate, true);
	assert.equal((await pending).duplicate, false);
	assert.equal(f.execCount(), 1);

	await assert.rejects(
		() => f.launcher.launch(f.input("start-1", "other-session")),
		(error: unknown) => error instanceof BridgeLaunchError && error.code === "operation-id-conflict",
	);
});

it("returns launch-result-unknown when the descriptor never appears", async () => {
	const f = fixture();
	const launcher = new BridgeLauncher({
		root: f.root,
		bridge: new BridgeHub({ root: f.root }),
		extensionPath: join(f.root, "extension.ts"),
		exec: async () => {},
		waitForDescriptor: async () => null,
	});
	await assert.rejects(
		() => launcher.launch(f.input("start-timeout")),
		(error: unknown) => error instanceof BridgeLaunchError && error.code === "launch-result-unknown",
	);
});
