// 运行目录、注册描述符与单写者所有权。
//
// 目录布局（全部 0700/0600）：
//   <root>/registry/<sessionId>.json            所有者描述符
//   <root>/registry/<sessionId>--<instanceId>.json  只读副本描述符
//   <root>/sockets/<instanceId>.sock           该实例的 IPC socket
//   <root>/owners/<sessionId>.json             单写者锁（pid + instanceId）
//
// 锁只约束加载了本扩展的实例；未加载扩展的原生 CLI 不受保护，产品文档不得写成
// “全宿主硬锁”。

import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import {
	BRIDGE_ROOT_ENV,
	BRIDGE_SCHEMA,
	type BridgeDescriptor,
	OWNERS_DIR,
	REGISTRY_DIR,
	SOCKETS_DIR,
} from "./protocol.ts";

export function resolveBridgeRoot(env: NodeJS.ProcessEnv = process.env): string {
	const override = env[BRIDGE_ROOT_ENV];
	if (typeof override === "string" && override.length > 0) return override;
	const agentDir =
		typeof env.PI_CODING_AGENT_DIR === "string" && env.PI_CODING_AGENT_DIR.length > 0
			? env.PI_CODING_AGENT_DIR
			: join(homedir(), ".pi", "agent");
	return join(agentDir, "mobile-bridge");
}

export function ensureBridgeDirs(root: string): void {
	for (const name of [REGISTRY_DIR, SOCKETS_DIR, OWNERS_DIR]) {
		mkdirSync(join(root, name), { recursive: true, mode: 0o700 });
		chmodSync(join(root, name), 0o700);
	}
}

/** pid 存活判定；Linux 上把僵尸进程当死亡，避免复用陈旧注册表。 */
export function isProcessAlive(pid: unknown): boolean {
	if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
	} catch {
		return false;
	}
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		const state = stat.slice(stat.lastIndexOf(")") + 1).trimStart()[0];
		return state !== "Z";
	} catch {
		// 非 Linux 平台没有 /proc；kill(pid,0) 成功即视为存活。
		return true;
	}
}

function readJson<T>(path: string): T | null {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch {
		return null;
	}
}

function writeJsonAtomic(path: string, value: unknown): void {
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
	renameSync(tmp, path);
}

export interface OwnershipRecord {
	schema: number;
	instanceId: string;
	epoch: string;
	sessionId: string;
	pid: number;
	socketPath: string;
	claimedAt: number;
}

/**
 * 抢占会话的写所有权。已存在存活所有者时返回 false（调用方降级为只读）。
 * 陈旧的锁（进程已退出）就地替换；wx 创建保证并发启动只有一个胜者。
 */
export function claimSessionOwner(root: string, record: OwnershipRecord): boolean {
	ensureBridgeDirs(root);
	const path = join(root, OWNERS_DIR, `${record.sessionId}.json`);
	for (let attempt = 0; attempt < 3; attempt += 1) {
		try {
			writeFileSync(path, `${JSON.stringify(record)}\n`, { flag: "wx", mode: 0o600 });
			chmodSync(path, 0o600);
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") return false;
			const existing = readJson<OwnershipRecord>(path);
			if (existing && existing.instanceId !== record.instanceId && isProcessAlive(existing.pid)) return false;
			try {
				unlinkSync(path);
			} catch (unlinkError) {
				if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") return false;
			}
		}
	}
	return false;
}

export function releaseSessionOwner(root: string, sessionId: string, instanceId: string): void {
	const path = join(root, OWNERS_DIR, `${sessionId}.json`);
	const existing = readJson<OwnershipRecord>(path);
	if (!existing || existing.instanceId !== instanceId) return;
	try {
		unlinkSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

export function descriptorPath(
	root: string,
	descriptor: Pick<BridgeDescriptor, "sessionId" | "instanceId" | "owner">,
): string {
	const suffix = descriptor.owner ? "" : `--${descriptor.instanceId}`;
	return join(root, REGISTRY_DIR, `${descriptor.sessionId}${suffix}.json`);
}

export function writeDescriptor(root: string, descriptor: BridgeDescriptor): string {
	const path = descriptorPath(root, descriptor);
	writeJsonAtomic(path, descriptor);
	return path;
}

export function removeDescriptor(
	root: string,
	descriptor: Pick<BridgeDescriptor, "sessionId" | "instanceId" | "owner">,
): void {
	try {
		unlinkSync(descriptorPath(root, descriptor));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

export function buildDescriptor(input: {
	instanceId: string;
	epoch: string;
	sessionId: string;
	socketPath: string;
	sessionFile: string | null;
	cwd: string;
	startedAt: number;
	owner: boolean;
	extensionVersion: string;
}): BridgeDescriptor {
	return { schema: BRIDGE_SCHEMA, pid: process.pid, ...input };
}
