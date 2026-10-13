// CLI 子进程回归：--public-url 必须在启动监听/创建设备注册表之前经过与
// mgmt 配对入口相同的 normalizePublicUrl 校验/规范化。
// 只使用本机回环监听与临时目录；不调用模型、不连外部服务、不读真实 ~/.pi。

import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MAIN_ENTRY = join(REPO_ROOT, "src", "main.ts");

const tmpRoots: string[] = [];
const allChildren: ChildProcess[] = [];

/** 兜底清理：无论测试成败，杀掉仍未退出的子进程并等其 exit 事件。
 * node:test 会等本文件派生的活子进程，遗留进程会让整个测试文件悬挂。 */
after(async () => {
	await Promise.all(
		allChildren.map(
			(child) =>
				new Promise<void>((resolveExit) => {
					if (child.exitCode !== null || child.signalCode !== null) return resolveExit();
					child.kill("SIGKILL");
					child.once("exit", () => resolveExit());
					setTimeout(resolveExit, 3000).unref();
				}),
		),
	);
	for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true });
});

interface RunningGateway {
	child: ChildProcess;
	deviceFile: string;
	out: string;
	err: string;
}

/** 只隔离设备、会话与 pi 配置目录，保留宿主 HOME 等系统环境变量。 */
function startGateway(extraArgs: string[], preloadSource?: string): RunningGateway {
	const root = mkdtempSync(join(tmpdir(), "pi-mgw-main-"));
	tmpRoots.push(root);
	const deviceFile = join(root, "devices.json");
	const preload = join(root, "network-fixture.mjs");
	if (preloadSource) writeFileSync(preload, preloadSource);
	const child = spawn(
		process.execPath,
		[
			"--experimental-strip-types",
			...(preloadSource ? ["--import", preload] : []),
			MAIN_ENTRY,
			...extraArgs,
			// 设备注册表与会话目录全部隔离，绝不触碰真实 ~/.pi 或用户设备注册表。
			"--device-file",
			deviceFile,
			"--session-dir",
			join(root, "sessions"),
		],
		{
			cwd: REPO_ROOT,
			env: {
				...process.env,
				// 隔离 pi 侧状态：即使运行时被触发也只落在临时目录。
				PI_CODING_AGENT_DIR: join(root, "pi-agent"),
			},
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	allChildren.push(child);
	const stdoutChunks: string[] = [];
	const stderrChunks: string[] = [];
	child.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk.toString()));
	child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk.toString()));
	return {
		child,
		deviceFile,
		get out(): string {
			return stdoutChunks.join("");
		},
		get err(): string {
			return stderrChunks.join("");
		},
	};
}

/** 等待子进程退出；超时先 SIGTERM 再 SIGKILL，避免孤儿进程拖垮测试。计时器 unref。 */
async function waitForExit(
	child: ChildProcess,
	timeoutMs: number,
): Promise<{ code: number | null; signal: string | null }> {
	if (child.exitCode !== null || child.signalCode !== null) {
		return { code: child.exitCode, signal: child.signalCode };
	}
	return await new Promise((resolveExit, rejectExit) => {
		const softTimer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
		const hardTimer = setTimeout(() => child.kill("SIGKILL"), timeoutMs + 2000);
		softTimer.unref();
		hardTimer.unref();
		child.once("error", (error) => {
			clearTimeout(softTimer);
			clearTimeout(hardTimer);
			rejectExit(error);
		});
		child.once("exit", (code, signal) => {
			clearTimeout(softTimer);
			clearTimeout(hardTimer);
			resolveExit({ code, signal });
		});
	});
}

/** 轮询管理面 /mgw/status 直到就绪，返回其 JSON；子进程提前退出则立即失败并带出 stderr。 */
async function waitForStatus(
	running: RunningGateway,
	mgmtPort: number,
	timeoutMs: number,
): Promise<{ publicUrl: string; dataPort: number }> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (running.child.exitCode !== null || running.child.signalCode !== null) {
			throw new Error(`子进程提前退出 (code=${running.child.exitCode})：\n${running.out}${running.err}`);
		}
		try {
			const response = await fetch(`http://127.0.0.1:${mgmtPort}/mgw/status`, {
				signal: AbortSignal.timeout(1_000),
			});
			if (response.ok) return (await response.json()) as { publicUrl: string; dataPort: number };
		} catch {
			// 未就绪，继续轮询。
		}
		await new Promise((resolveTick) => setTimeout(resolveTick, 100));
	}
	throw new Error(`等待管理面就绪超时 (${mgmtPort})：\n${running.out}${running.err}`);
}

interface IsolatedPorts {
	args: string[];
	dataPort: number;
	mgmtPort: number;
}

/** 同时预留两个不同的空闲端口，再交给不接受端口 0 的 CLI 使用。 */
async function isolatedPorts(): Promise<IsolatedPorts> {
	const listeners = [createServer(), createServer()];
	try {
		for (const server of listeners) {
			await new Promise<void>((ready, rejectListen) => {
				server.once("error", rejectListen);
				server.listen(0, "127.0.0.1", ready);
			});
		}
		const ports = listeners.map((server) => {
			const address = server.address();
			assert.ok(address && typeof address === "object");
			return address.port;
		});
		const [dataPort, mgmtPort] = ports;
		return {
			args: ["--bind", "127.0.0.1", "--data-port", String(dataPort), "--mgmt-port", String(mgmtPort)],
			dataPort,
			mgmtPort,
		};
	} finally {
		await Promise.all(
			listeners
				.filter((server) => server.listening)
				.map((server) => new Promise<void>((closed) => server.close(() => closed()))),
		);
	}
}

describe("main.ts CLI 启动时的 --public-url 校验", () => {
	it("自动检测到公网网卡时，未请求配对仍能启动", async () => {
		const ports = await isolatedPorts();
		const running = startGateway(
			ports.args,
			`
			import os from 'node:os';
			import { syncBuiltinESMExports } from 'node:module';
			os.networkInterfaces = () => ({ eth0: [{ family: 'IPv4', internal: false, address: '203.0.113.9' }] });
			syncBuiltinESMExports();
		`,
		);
		const status = await waitForStatus(running, ports.mgmtPort, 15000);
		assert.equal(status.publicUrl, `ws://127.0.0.1:${ports.dataPort}/ws/mobile`);
		running.child.kill("SIGTERM");
		assert.equal((await waitForExit(running.child, 10000)).code, 0);
	});

	it("拒绝指向公网地址的明文 ws://：退出报错，不生成设备注册表", async () => {
		const running = startGateway(["--public-url", "ws://203.0.113.9:3082/ws/mobile", ...(await isolatedPorts()).args]);
		const exit = await waitForExit(running.child, 15000);
		assert.notEqual(exit.code, 0, `应启动失败退出，实际 code=${exit.code}\n${running.out}${running.err}`);
		assert.match(running.err, /无效的 --public-url/, running.err);
		assert.ok(!running.out.includes("已启动"), "不应走到启动完成输出");
		assert.equal(existsSync(running.deviceFile), false, "失败时不应生成设备注册表文件");
	});

	it("拒绝携带嵌入凭据的 --public-url", async () => {
		const running = startGateway([
			"--public-url",
			"ws://user:pass@10.123.0.1:3082/ws/mobile",
			...(await isolatedPorts()).args,
		]);
		const exit = await waitForExit(running.child, 15000);
		assert.notEqual(exit.code, 0);
		assert.match(running.err, /无效的 --public-url/, running.err);
		assert.equal(existsSync(running.deviceFile), false);
	});

	it("合法私网 ws:// 正常启动，管理面回报归一化后的 publicUrl", async () => {
		const ports = await isolatedPorts();
		const running = startGateway(["--public-url", "ws://10.123.0.1:3082/ws/mobile", ...ports.args]);
		const status = await waitForStatus(running, ports.mgmtPort, 15000);
		assert.equal(status.publicUrl, "ws://10.123.0.1:3082/ws/mobile");
		assert.equal(status.dataPort, ports.dataPort);
		running.child.kill("SIGTERM");
		const exit = await waitForExit(running.child, 10000);
		assert.equal(
			exit.code,
			0,
			`SIGTERM 后应正常退出，实际 code=${exit.code} signal=${exit.signal}\n${running.out}${running.err}`,
		);
	});

	it("合法公网 wss:// 正常启动", async () => {
		const ports = await isolatedPorts();
		const running = startGateway(["--public-url", "wss://gw.example.com/ws/mobile", ...ports.args]);
		const status = await waitForStatus(running, ports.mgmtPort, 15000);
		assert.equal(status.publicUrl, "wss://gw.example.com/ws/mobile");
		running.child.kill("SIGTERM");
		const exit = await waitForExit(running.child, 10000);
		assert.equal(exit.code, 0);
	});

	it("http:// 私网地址遵循既有 validator 升级为 ws://", async () => {
		const ports = await isolatedPorts();
		const running = startGateway(["--public-url", "http://10.123.0.1:3082/ws/mobile", ...ports.args]);
		const status = await waitForStatus(running, ports.mgmtPort, 15000);
		assert.equal(status.publicUrl, "ws://10.123.0.1:3082/ws/mobile");
		running.child.kill("SIGTERM");
		const exit = await waitForExit(running.child, 10000);
		assert.equal(exit.code, 0);
	});
});
