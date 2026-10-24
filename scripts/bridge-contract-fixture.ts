// 跨仓库队列契约：生产路由 + 脚本化原生应答，输出交给 Android 生产解码器。
// 不打开 SDK 会话，不读取真实配置或启动模型。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BridgeHub } from "../src/bridge.ts";
import { HostModeStore } from "../src/host-mode.ts";
import { PiRuntime } from "../src/pi-runtime.ts";
import { connectClient } from "../src/router.ts";

const root = mkdtempSync(join(tmpdir(), "pi-bridge-contract-"));
const mode = new HostModeStore(join(root, "mode.json"));
mode.write("bridge");
const identity = { sessionId: "contract-session", instanceId: "contract-instance", epoch: "contract-epoch" };
const runtime = Object.assign(Object.create(PiRuntime.prototype), {
	openSession: () => {
		throw Error("SDK forbidden");
	},
}) as PiRuntime;
const bridge = {
	descriptor: () => ({ ...identity, cwd: root }),
	treeControl: async () => ({
		ok: true,
		entryId: "user-node",
		editorText: "node text",
		alreadyAt: false,
		snapshot: {
			...identity,
			busy: false,
			isCompacting: false,
			pending: false,
			leafId: "parent-node",
			model: { provider: "fixture", modelId: "offline" },
			thinkingLevel: "off",
			contextUsage: null,
		},
	}),
} as unknown as BridgeHub;
const frames: Record<string, unknown>[] = [];
const client = connectClient(runtime, (f) => frames.push(f), { hostModeStore: mode, bridge });
try {
	await client.handleMessage({
		type: "switch-branch",
		...identity,
		operationId: "contract-operation",
		entryId: "user-node",
	});
	if (frames.length !== 1 || frames[0].kind !== "branch-switched") throw Error("missing branch receipt");
	process.stdout.write(JSON.stringify(frames[0]) + "\n");
} finally {
	client.close();
	rmSync(root, { recursive: true, force: true });
}
