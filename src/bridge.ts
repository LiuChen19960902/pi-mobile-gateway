// 原生 Pi 桥接实例的本机 IPC 客户端：注册表发现、请求/应答、事件订阅。
//
// 网关只信任注册表里 schema 匹配且 pid 存活的描述符；每个请求都带
// instanceId/epoch/sessionId，扩展端据此拒绝过期实例的回调。socket 暂时不可达
// 不等于进程死亡：由调用方决定是重试还是回 bridge-offline。

import { readdirSync, readFileSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { join } from "node:path";
import process from "node:process";
import {
	BRIDGE_MAX_FRAME_BYTES,
	BRIDGE_SCHEMA,
	type BridgeDescriptor,
	type BridgeEventFrame,
	type BridgeImage,
	type BridgeReply,
	type BridgeRequest,
	type BridgeSnapshot,
	REGISTRY_DIR,
} from "../bridge-extension/src/protocol.ts";
import { isProcessAlive } from "../bridge-extension/src/registry.ts";

const REQUEST_TIMEOUT_MS = 8_000;
const ABORT_TIMEOUT_MS = 14_000;

export class BridgeUnavailableError extends Error {
	readonly code = "bridge-unavailable";
	constructor(message: string) {
		super(message);
		this.name = "BridgeUnavailableError";
	}
}

/** 请求被扩展拒绝；code 为桥接协议的稳定错误码。 */
export class BridgeRequestError extends Error {
	readonly code: string;
	/** abort 取出队列后失败时，扩展已把文字交回；调用方不能把它丢掉。 */
	readonly queuedText?: string;
	/** 取队列三态（扩展给出时）：失败回执同样要能区分"没执行/已捕获/结果不明"。 */
	readonly queuedDisposition?: "captured" | "left-on-desktop" | "unknown";

	constructor(
		code: string,
		message: string,
		queuedText?: string,
		queuedDisposition?: "captured" | "left-on-desktop" | "unknown",
	) {
		super(message);
		this.name = "BridgeRequestError";
		this.code = code;
		if (queuedText !== undefined) this.queuedText = queuedText;
		if (queuedDisposition !== undefined) this.queuedDisposition = queuedDisposition;
	}
}

interface FrameWaiter {
	resolve: (reply: BridgeReply) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

class BridgeSocket {
	private readonly socket: Socket;
	private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
	private readonly waiters = new Map<string, FrameWaiter>();
	private readonly listeners = new Set<(frame: unknown) => void>();
	private closeListeners = new Set<(reason: string) => void>();
	hello: BridgeSnapshot | null = null;

	private constructor(socket: Socket) {
		this.socket = socket;
		socket.on("data", (chunk: Buffer) => this.onData(chunk));
		socket.on("error", () => socket.destroy());
		socket.on("close", () => {
			for (const waiter of this.waiters.values()) {
				clearTimeout(waiter.timer);
				waiter.reject(new BridgeUnavailableError("bridge socket closed"));
			}
			this.waiters.clear();
			for (const listener of this.closeListeners) listener("socket-closed");
			this.closeListeners.clear();
		});
	}

	static open(path: string, signal?: AbortSignal): Promise<BridgeSocket> {
		return new Promise((resolve, reject) => {
			if (signal?.aborted) {
				reject(new BridgeUnavailableError("bridge query cancelled"));
				return;
			}
			const socket = createConnection(path);
			let settled = false;
			const timer = setTimeout(() => {
				if (settled) return;
				settled = true;
				signal?.removeEventListener("abort", abort);
				socket.destroy();
				reject(new BridgeUnavailableError("bridge socket timeout"));
			}, REQUEST_TIMEOUT_MS);
			const abort = () => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				signal?.removeEventListener("abort", abort);
				socket.destroy();
				reject(new BridgeUnavailableError("bridge query cancelled"));
			};
			signal?.addEventListener("abort", abort, { once: true });
			socket.once("connect", () => {
				if (settled) return;
				settled = true;
				signal?.removeEventListener("abort", abort);
				clearTimeout(timer);
				resolve(new BridgeSocket(socket));
			});
			socket.once("error", (error) => {
				if (settled) return;
				settled = true;
				signal?.removeEventListener("abort", abort);
				clearTimeout(timer);
				reject(new BridgeUnavailableError(String(error)));
			});
		});
	}

	private onData(chunk: Buffer): void {
		this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
		if (this.buffer.length > BRIDGE_MAX_FRAME_BYTES) {
			// 扩展端同预算；这里也按字节判，避免半帧/大响应把内存拖爆。
			// 读缓冲超限不是原生实例离线：先让在途请求按稳定大小错误收敛，
			// 再关闭这条 IPC，由调用方决定是否重连。
			for (const [id, waiter] of this.waiters) {
				clearTimeout(waiter.timer);
				waiter.reject(new BridgeRequestError("frame-too-large", "bridge reply exceeds frame limit"));
				this.waiters.delete(id);
			}
			for (const listener of this.closeListeners) listener("frame-too-large");
			this.closeListeners.clear();
			this.socket.destroy();
			return;
		}
		for (;;) {
			const newline = this.buffer.indexOf(0x0a);
			if (newline < 0) break;
			const line = this.buffer.subarray(0, newline);
			this.buffer = this.buffer.subarray(newline + 1);
			if (line.length === 0) continue;
			let frame: Record<string, unknown>;
			try {
				// 完整一行再解码，中文跨 chunk 不会被替换成 U+FFFD。
				frame = JSON.parse(line.toString("utf8")) as Record<string, unknown>;
			} catch {
				continue;
			}
			if (frame.kind === "hello" && frame.snapshot) {
				this.hello = frame.snapshot as BridgeSnapshot;
				for (const listener of this.listeners) listener(frame);
				continue;
			}
			if (frame.kind === "event") {
				for (const listener of this.listeners) listener(frame);
				continue;
			}
			if (frame.kind === "reply" && typeof frame.id === "string") {
				const waiter = this.waiters.get(frame.id);
				if (waiter) {
					this.waiters.delete(frame.id);
					clearTimeout(waiter.timer);
					waiter.resolve(frame as unknown as BridgeReply);
				}
				continue;
			}
			for (const listener of this.listeners) listener(frame);
		}
	}

	onFrame(listener: (frame: unknown) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	onClose(listener: (reason: string) => void): () => void {
		this.closeListeners.add(listener);
		return () => this.closeListeners.delete(listener);
	}

	request(
		descriptor: BridgeDescriptor,
		op: BridgeRequest["op"],
		payload: Record<string, unknown> = {},
		timeoutMs = REQUEST_TIMEOUT_MS,
	): Promise<BridgeReply> {
		const id = `gw-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
		const line = `${JSON.stringify({
			id,
			op,
			instanceId: descriptor.instanceId,
			epoch: descriptor.epoch,
			sessionId: descriptor.sessionId,
			...payload,
		})}\n`;
		if (Buffer.byteLength(line, "utf8") > BRIDGE_MAX_FRAME_BYTES) {
			// 合法 WS 图片被 IPC 上限挡住时，回稳定 frame-too-large，
			// 不能等 socket 断开后被路由层误报成 bridge-offline。
			return Promise.reject(new BridgeRequestError("frame-too-large", "bridge request exceeds frame limit"));
		}
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.waiters.delete(id);
				reject(new BridgeUnavailableError(`bridge request timeout: ${op}`));
			}, timeoutMs);
			this.waiters.set(id, { resolve, reject, timer });
			try {
				this.socket.write(line);
			} catch (error) {
				clearTimeout(timer);
				this.waiters.delete(id);
				reject(new BridgeUnavailableError(String(error)));
			}
		});
	}

	close(): void {
		this.socket.destroy();
	}
}

function requireOk(reply: BridgeReply): BridgeReply {
	if (!reply.ok) {
		throw new BridgeRequestError(
			reply.code ?? "internal",
			"bridge request rejected",
			typeof reply.queuedText === "string" ? reply.queuedText : undefined,
			reply.queuedDisposition,
		);
	}
	return reply;
}

export interface BridgeHubOptions {
	root: string;
	log?: (message: string) => void;
}

/** 注册表扫描与请求封装；不缓存 snapshot，订阅路径自行维护连接。 */
export class BridgeHub {
	readonly root: string;
	private readonly log: (message: string) => void;

	constructor(options: BridgeHubOptions) {
		this.root = options.root;
		this.log = options.log ?? (() => {});
	}

	/** 读取注册表，过滤 schema 不符、进程已退出与只读副本。 */
	descriptors(): BridgeDescriptor[] {
		return this.discover().descriptors;
	}

	/** 删除确认还需要知道注册表是否读全；未知实例不能冒充离线。 */
	discover(): { descriptors: BridgeDescriptor[]; complete: boolean } {
		let complete = true;
		let names: string[];
		try {
			names = readdirSync(join(this.root, REGISTRY_DIR)).filter((name) => name.endsWith(".json"));
		} catch (error) {
			return { descriptors: [], complete: (error as NodeJS.ErrnoException).code === "ENOENT" };
		}
		const bySession = new Map<string, BridgeDescriptor>();
		for (const name of names) {
			let value: BridgeDescriptor;
			try {
				value = JSON.parse(readFileSync(join(this.root, REGISTRY_DIR, name), "utf8")) as BridgeDescriptor;
			} catch {
				complete = false;
				continue;
			}
			if (!value || value.schema !== BRIDGE_SCHEMA || typeof value.sessionId !== "string") {
				complete = false;
				continue;
			}
			if (!isProcessAlive(value.pid)) continue;
			const previous = bySession.get(value.sessionId);
			if (!previous || (!previous.owner && value.owner) || previous.startedAt < value.startedAt) {
				bySession.set(value.sessionId, value);
			}
		}
		return { descriptors: [...bySession.values()], complete };
	}

	descriptor(sessionId: string): BridgeDescriptor | undefined {
		return this.descriptors().find((value) => value.sessionId === sessionId);
	}

	async snapshot(descriptor: BridgeDescriptor): Promise<BridgeSnapshot> {
		return this.withSocket(descriptor, async (socket) => {
			const reply = await socket.request(descriptor, "snapshot");
			if (!reply.ok || !reply.snapshot) throw new BridgeRequestError(reply.code ?? "internal", "snapshot rejected");
			return reply.snapshot;
		});
	}

	async history(
		descriptor: BridgeDescriptor,
		beforeEntryId: string | undefined,
		limit: number,
	): Promise<{ entries: unknown[]; hasMore: boolean; oldestEntryId: string | null }> {
		return this.withSocket(descriptor, async (socket) => {
			const reply = await socket.request(descriptor, "history", {
				...(beforeEntryId !== undefined ? { beforeEntryId } : {}),
				limit,
			});
			if (!reply.ok) throw new BridgeRequestError(reply.code ?? "internal", "history rejected");
			return {
				entries: Array.isArray(reply.entries) ? reply.entries : [],
				hasMore: reply.hasMore === true,
				oldestEntryId: typeof reply.oldestEntryId === "string" ? reply.oldestEntryId : null,
			};
		});
	}

	async treeControl(
		descriptor: BridgeDescriptor,
		op: "tree" | "entry-copy" | "label-put" | "name" | "switch-branch",
		input: Record<string, unknown> = {},
	): Promise<BridgeReply> {
		return this.withSocket(descriptor, async (socket) => requireOk(await socket.request(descriptor, op, input)));
	}

	async forkWorkspace(
		descriptor: BridgeDescriptor,
		input: { operationId: string; targetPath: string; sessionDir?: string },
	): Promise<BridgeReply> {
		return this.withSocket(descriptor, async (socket) =>
			requireOk(await socket.request(descriptor, "worktree-fork", input)),
		);
	}

	async inputResources(descriptor: BridgeDescriptor, signal?: AbortSignal): Promise<BridgeReply> {
		return this.withSocket(
			descriptor,
			async (socket) => requireOk(await socket.request(descriptor, "input-resources")),
			signal,
		);
	}

	async models(descriptor: BridgeDescriptor): Promise<BridgeReply> {
		return this.withSocket(descriptor, async (socket) => requireOk(await socket.request(descriptor, "models")));
	}

	async refreshModel(descriptor: BridgeDescriptor, operationId: string): Promise<BridgeReply> {
		return this.withSocket(descriptor, async (socket) =>
			requireOk(await socket.request(descriptor, "refresh-model", { operationId })),
		);
	}
	async setModel(
		descriptor: BridgeDescriptor,
		input: { operationId: string; provider: string; modelId: string; thinkingLevel?: string },
	): Promise<BridgeReply> {
		return this.withSocket(descriptor, async (socket) =>
			requireOk(await socket.request(descriptor, "set-model", input)),
		);
	}

	async compact(descriptor: BridgeDescriptor, input: { operationId: string }): Promise<BridgeReply> {
		return this.withSocket(descriptor, async (socket) => requireOk(await socket.request(descriptor, "compact", input)));
	}

	async send(
		descriptor: BridgeDescriptor,
		input: { operationId: string; text: string; images?: BridgeImage[]; deliverAs?: "steer" | "followUp" },
	): Promise<BridgeReply> {
		return this.withSocket(descriptor, async (socket) => requireOk(await socket.request(descriptor, "send", input)));
	}

	async abort(
		descriptor: BridgeDescriptor,
		input: { operationId: string; restoreQueued?: boolean },
	): Promise<BridgeReply> {
		return this.withSocket(descriptor, async (socket) =>
			requireOk(await socket.request(descriptor, "abort", input, ABORT_TIMEOUT_MS)),
		);
	}

	async dequeue(descriptor: BridgeDescriptor, input: { operationId: string }): Promise<BridgeReply> {
		return this.withSocket(descriptor, async (socket) => requireOk(await socket.request(descriptor, "dequeue", input)));
	}

	async operationStatus(descriptor: BridgeDescriptor, operationId: string): Promise<BridgeReply> {
		return this.withSocket(descriptor, async (socket) => {
			const reply = await socket.request(descriptor, "operation-status", { operationId });
			if (!reply.ok) throw new BridgeRequestError(reply.code ?? "internal", "operation status rejected");
			return reply;
		});
	}

	/** 只读订阅：hello → snapshot 回调，之后逐事件转发；close 交给调用方重连。 */
	async subscribe(
		descriptor: BridgeDescriptor,
		handlers: {
			onSnapshot: (snapshot: BridgeSnapshot) => void;
			onEvent: (frame: BridgeEventFrame) => void;
			onClose: (reason: string) => void;
		},
	): Promise<() => void> {
		const socket = await BridgeSocket.open(descriptor.socketPath);
		const detach = socket.onFrame((frame) => {
			const value = frame as Record<string, unknown>;
			if (value.kind === "hello" && value.snapshot) handlers.onSnapshot(value.snapshot as BridgeSnapshot);
			else if (value.kind === "event") handlers.onEvent(value as unknown as BridgeEventFrame);
		});
		const offClose = socket.onClose(handlers.onClose);
		return () => {
			detach();
			offClose();
			socket.close();
		};
	}

	private async withSocket<T>(
		descriptor: BridgeDescriptor,
		run: (socket: BridgeSocket) => Promise<T>,
		signal?: AbortSignal,
	): Promise<T> {
		const socket = await BridgeSocket.open(descriptor.socketPath, signal);
		const abort = () => socket.close();
		signal?.addEventListener("abort", abort, { once: true });
		try {
			if (signal?.aborted) throw new BridgeUnavailableError("bridge query cancelled");
			// 连接建立时 hello 可能还没到，不能在这里用 socket.hello 判断代际；
			// 每个请求带 instanceId/epoch，由扩展端 handle() 做权威 stale-runtime 校验。
			return await run(socket);
		} finally {
			signal?.removeEventListener("abort", abort);
			socket.close();
		}
	}
}
