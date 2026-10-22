// 后台启动原生 Pi 实例：网关替手机执行 `tmux new-session`，只等待扩展注册表
// 出现描述符，不解析 Pi TUI 输出。操作 ID 与 sessionId 双重去重，避免手机
// 重试或双击开出两个实例。

import { execFile as execFileCallback } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { BridgeHub } from "./bridge.ts";

const execFile = promisify(execFileCallback);
const SESSION_NAME_PREFIX = "pi-mobile-";
const START_TIMEOUT_MS = 20_000;
const POLL_INTERVAL_MS = 100;
const OPERATION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export class BridgeLaunchError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "BridgeLaunchError";
		this.code = code;
	}
}

export type BridgeLaunchInput = { operationId: string; sessionId: string; cwd: string } & (
	| { sessionFile: string; newSession?: false; sessionDir?: never }
	| { newSession: true; sessionFile?: never; sessionDir?: string }
);

export interface BridgeLaunchResult {
	sessionId: string;
	instanceId: string;
	epoch: string;
	pid: number;
	duplicate: boolean;
	attachHint: string;
}

interface LaunchJournal {
	digest: string;
	result: BridgeLaunchResult;
}

interface LauncherOptions {
	root: string;
	bridge: BridgeHub;
	/** 测试注入：替代 tmux 调用；抛错即视为启动失败。 */
	exec?: (command: string, args: string[], options: { env: NodeJS.ProcessEnv; cwd?: string }) => Promise<unknown>;
	/** 测试注入：替代轮询等待。 */
	waitForDescriptor?: (sessionId: string, timeoutMs: number) => Promise<BridgeLaunchResult | null>;
	piBin?: string;
	extensionPath?: string;
	tmuxBin?: string;
}

/**
 * 启动结果无法在超时后确认真实状态：可能与已启动的实例并存。此时保留日志并
 * 返回可重试的稳定错误，而不是盲目再开一个。日志按 operationId 落盘，网关
 * 重启后相同 ID 仍能去重。
 */
export class BridgeLauncher {
	private readonly root: string;
	private readonly bridge: BridgeHub;
	private readonly exec: NonNullable<LauncherOptions["exec"]>;
	private readonly piBin: string;
	private readonly extensionPath: string;
	private readonly tmuxBin: string;
	private readonly inFlight = new Map<string, Promise<BridgeLaunchResult>>();
	/** operationId 的同步占位：两次调用在同一 tick 进入时，不能都走到 launchNew。 */
	private readonly reservedOperations = new Map<string, { digest: string; result: Promise<BridgeLaunchResult> }>();

	constructor(options: LauncherOptions) {
		this.root = options.root;
		this.bridge = options.bridge;
		this.exec = options.exec ?? ((command, args, execOptions) => execFile(command, args, execOptions));
		const here = dirname(fileURLToPath(import.meta.url));
		this.piBin = options.piBin ?? process.env.PI_MOBILE_PI_BIN ?? "pi";
		this.extensionPath = options.extensionPath ?? resolve(here, "../bridge-extension/src/index.ts");
		this.tmuxBin = options.tmuxBin ?? "tmux";
		this.waitForDescriptor =
			options.waitForDescriptor ?? ((sessionId, timeoutMs) => this.pollDescriptor(sessionId, timeoutMs));
	}

	private readonly waitForDescriptor: (sessionId: string, timeoutMs: number) => Promise<BridgeLaunchResult | null>;

	async launch(input: BridgeLaunchInput): Promise<BridgeLaunchResult> {
		if (!OPERATION_ID_PATTERN.test(input.operationId)) {
			throw new BridgeLaunchError("bad-request", "operationId 格式无效");
		}
		// sessionId 直接进 tmux session 名和 attach 命令；只接受安全字符，
		// 不用替换后的名字，避免“启动的名字”和 `pi-mobile attach` 不一致。
		if (!OPERATION_ID_PATTERN.test(input.sessionId)) {
			throw new BridgeLaunchError("bad-request", "sessionId 格式不支持后台启动");
		}
		if (!existsSync(this.extensionPath)) {
			throw new BridgeLaunchError("bridge-start-failed", "bridge extension is not installed");
		}
		const digest = input.newSession
			? `${input.sessionId}\nnew:${input.cwd}\n${input.sessionDir ?? ""}`
			: `${input.sessionId}\n${input.sessionFile}`;
		const journal = this.readJournal(input.operationId);
		if (journal) {
			if (journal.digest !== digest) {
				throw new BridgeLaunchError("operation-id-conflict", "operationId 已用于其他会话");
			}
			// 日志只证明“当时启动过这个 instance+session+epoch”。原生 /new 后
			// 同一 instanceId 可能已指向另一个会话，旧 session 也可能被关掉；
			// 必须三者都仍在线才算可回放，否则如实返回 unknown 让用户刷新。
			const live = this.bridge
				.descriptors()
				.find(
					(item) =>
						item.instanceId === journal.result.instanceId &&
						item.sessionId === journal.result.sessionId &&
						item.epoch === journal.result.epoch,
				);
			if (!live) {
				throw new BridgeLaunchError("launch-result-unknown", "之前启动的实例已不在线，请稍后重试");
			}
			return { ...journal.result, duplicate: true };
		}

		const reserved = this.reservedOperations.get(input.operationId);
		if (reserved) {
			if (reserved.digest !== digest) {
				throw new BridgeLaunchError("operation-id-conflict", "operationId 已用于其他会话");
			}
			return { ...(await reserved.result), duplicate: true };
		}

		const existing = this.bridge.descriptors().find((item) => item.sessionId === input.sessionId);
		if (existing) {
			const result = resultFromDescriptor(existing, true);
			this.writeJournal(input.operationId, { digest, result });
			return result;
		}

		const pending = this.inFlight.get(input.sessionId);
		if (pending) {
			const result = await pending;
			this.writeJournal(input.operationId, { digest, result });
			return { ...result, duplicate: true };
		}

		const launch = this.launchNew(input);
		// 纯文本同步占位：同一 operationId 的并发调用在第一个 await 前只能有一个
		// 进入启动流程；不同目标会在这里按 digest 冲突，而不是各起一个 tmux。
		this.reservedOperations.set(input.operationId, { digest, result: launch });
		this.inFlight.set(input.sessionId, launch);
		try {
			const result = await launch;
			this.writeJournal(input.operationId, { digest, result });
			return result;
		} finally {
			this.reservedOperations.delete(input.operationId);
			this.inFlight.delete(input.sessionId);
		}
	}

	private async launchNew(input: BridgeLaunchInput): Promise<BridgeLaunchResult> {
		const sessionName = `${SESSION_NAME_PREFIX}${input.sessionId}`;
		const socketPath = join(this.root, "tmux.sock");
		mkdirSync(this.root, { recursive: true });
		const env: NodeJS.ProcessEnv = {
			...process.env,
			// 扩展与网关必须看同一个注册表；显式覆盖客户端环境里的旧值。
			PI_MOBILE_BRIDGE_ROOT: this.root,
		};
		try {
			await this.exec(
				this.tmuxBin,
				[
					"-S",
					socketPath,
					"-f",
					"/dev/null",
					"new-session",
					"-d",
					"-s",
					sessionName,
					"-c",
					input.cwd,
					"--",
					this.piBin,
					...(input.newSession
						? ["--session-id", input.sessionId, ...(input.sessionDir ? ["--session-dir", input.sessionDir] : [])]
						: ["--session", input.sessionFile]),
					"-e",
					this.extensionPath,
					"--tui-mode",
					"regular",
				],
				{ env, cwd: input.cwd },
			);
		} catch (error) {
			// tmux 的 duplicate session 说明上次启动已成功但注册表尚未可见；
			// 继续等描述符，不把重试误报成失败。
			if (!isDuplicateSession(error)) {
				throw new BridgeLaunchError("bridge-start-failed", "无法启动后台 pi");
			}
		}
		const descriptor = await this.waitForDescriptor(input.sessionId, START_TIMEOUT_MS);
		if (!descriptor) {
			throw new BridgeLaunchError("launch-result-unknown", "启动结果未知，请稍后刷新在线状态");
		}
		return descriptor;
	}

	private async pollDescriptor(sessionId: string, timeoutMs: number): Promise<BridgeLaunchResult | null> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const descriptor = this.bridge.descriptors().find((item) => item.sessionId === sessionId);
			if (descriptor) return resultFromDescriptor(descriptor, false);
			if (Date.now() >= deadline) return null;
			await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
		}
	}

	private journalPath(operationId: string): string {
		return join(this.root, "launches", `${operationId}.json`);
	}

	private readJournal(operationId: string): LaunchJournal | null {
		const path = this.journalPath(operationId);
		try {
			const parsed = JSON.parse(readFileSync(path, "utf8")) as LaunchJournal;
			return typeof parsed.digest === "string" ? parsed : null;
		} catch {
			return null;
		}
	}

	private writeJournal(operationId: string, journal: LaunchJournal): void {
		const path = this.journalPath(operationId);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${JSON.stringify(journal)}\n`);
	}
}

function resultFromDescriptor(
	descriptor: { sessionId: string; instanceId: string; epoch: string; pid: number },
	duplicate: boolean,
): BridgeLaunchResult {
	return {
		sessionId: descriptor.sessionId,
		instanceId: descriptor.instanceId,
		epoch: descriptor.epoch,
		pid: descriptor.pid,
		duplicate,
		attachHint: `pi-mobile attach ${descriptor.sessionId}`,
	};
}

function isDuplicateSession(error: unknown): boolean {
	const text =
		error instanceof Error ? `${error.message} ${String((error as { stderr?: unknown }).stderr ?? "")}` : String(error);
	return /duplicate session|already exists/i.test(text);
}
