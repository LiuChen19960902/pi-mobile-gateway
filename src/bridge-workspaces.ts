import { createHash } from "node:crypto";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { BridgeDescriptor, BridgeImage, BridgeReply, BridgeSnapshot } from "../bridge-extension/src/protocol.ts";
import { type BridgeHub, BridgeRequestError } from "./bridge.ts";
import { BridgeLaunchError, type BridgeLauncher } from "./bridge-launch.ts";
import { createWorktree, WorktreeError, type WorktreeOperation, WorktreeOperations } from "./worktrees.ts";

interface NativeWorkspaceOperation extends WorktreeOperation {
	nativeResumePhase?: "start" | "send";
	targetSessionFile?: string;
	expectedModel?: BridgeSnapshot["model"];
	expectedThinking?: string;
	expectedInstanceId?: string;
	expectedEpoch?: string;
}

/** 桥接操作使用独立日志；查询结果也不能借 SDK 打开原生会话。 */
export class BridgeWorkspaces {
	private readonly journal: WorktreeOperations;
	private readonly bridge: BridgeHub;
	private readonly launcher: BridgeLauncher;
	private readonly sessionDir?: string;
	private readonly trust: (path: string, trusted?: boolean) => string;
	constructor(options: {
		bridge: BridgeHub;
		launcher: BridgeLauncher;
		sessionDir?: string;
		trust: (path: string, trusted?: boolean) => string;
	}) {
		this.bridge = options.bridge;
		this.launcher = options.launcher;
		this.sessionDir = options.sessionDir;
		this.trust = options.trust;
		this.journal = new WorktreeOperations(join(options.bridge.root, "workspaces"));
	}

	async create(operationId: string, cwd: string, branch: string, base: string, targetPath: string) {
		const initial: WorktreeOperation = { operationId, action: "create", status: "pending", cwd: targetPath };
		return this.journal.run(
			operationId,
			JSON.stringify(["create", cwd, branch, base, targetPath]),
			initial,
			async () => {
				const worktree = await createWorktree(cwd, branch, base, targetPath);
				return { ...initial, status: "succeeded", cwd: worktree.path, worktree };
			},
		);
	}

	private async verifiedTarget(result: NativeWorkspaceOperation): Promise<BridgeDescriptor> {
		const descriptor = result.targetSessionId && this.bridge.descriptor(result.targetSessionId);
		if (!descriptor || descriptor.cwd !== result.cwd || !descriptor.owner)
			throw new WorktreeError("worktree-result-unknown");
		if (
			(result.expectedInstanceId && descriptor.instanceId !== result.expectedInstanceId) ||
			(result.expectedEpoch && descriptor.epoch !== result.expectedEpoch)
		)
			throw new WorktreeError("worktree-result-unknown");
		const snapshot = await this.bridge.snapshot(descriptor);
		if (
			snapshot.instanceId !== descriptor.instanceId ||
			snapshot.epoch !== descriptor.epoch ||
			snapshot.sessionId !== descriptor.sessionId ||
			snapshot.cwd !== result.cwd ||
			(result.targetSessionFile !== undefined && snapshot.sessionFile !== result.targetSessionFile) ||
			!snapshot.owner
		)
			throw new WorktreeError("worktree-result-unknown");
		if (
			(result.expectedModel &&
				(snapshot.model?.provider !== result.expectedModel.provider ||
					snapshot.model?.modelId !== result.expectedModel.modelId)) ||
			(result.expectedThinking !== undefined && snapshot.thinkingLevel !== result.expectedThinking)
		)
			throw new WorktreeError("worktree-model-unavailable");
		return descriptor;
	}

	async status(operationId: string): Promise<WorktreeOperation> {
		const saved = this.journal.status(operationId) as NativeWorkspaceOperation;
		// 工作区查询不能把原生提交的unknown提升成成功；只有原生收据能确认。
		if (saved.nativeResumePhase) return this.publicResult(saved);
		if (saved.status !== "unknown" || saved.action !== "continue" || !saved.targetSessionId)
			return this.publicResult(saved);
		try {
			await this.verifiedTarget(saved);
			const result = { ...saved, status: "succeeded" as const, code: undefined };
			this.journal.complete(operationId, result);
			return this.publicResult(result);
		} catch {
			return this.publicResult(saved);
		}
	}

	async fork(
		operationId: string,
		source: BridgeDescriptor,
		targetPath: string,
		trusted = false,
		retry = false,
	): Promise<WorktreeOperation> {
		const cwd = this.trust(targetPath, trusted);
		if (operationId === source.sessionId) throw new WorktreeError("worktree-operation-conflict");
		const initial: NativeWorkspaceOperation = {
			...this.journal.previous(operationId),
			operationId,
			action: "continue",
			status: "pending",
			sessionId: source.sessionId,
			cwd,
		};
		const result = await this.journal.run(
			operationId,
			JSON.stringify(["fork", source.sessionId, cwd]),
			initial,
			async () => {
				const current = this.bridge.descriptor(source.sessionId);
				if (!current || current.instanceId !== source.instanceId || current.epoch !== source.epoch)
					throw new WorktreeError("bridge-stale-runtime");
				if (!current.owner) throw new WorktreeError("session-owned");
				if (cwd === source.cwd) {
					const same = { ...initial, targetSessionId: source.sessionId };
					const descriptor = await this.verifiedTarget(same);
					const state = await this.bridge.snapshot(descriptor);
					if (state.busy || state.controlPending) throw new WorktreeError("worktree-busy");
					if (state.pending) throw new WorktreeError("worktree-queued");
					return { ...same, status: "succeeded" };
				}
				let checkpoint = this.journal.previous(operationId) as NativeWorkspaceOperation;
				try {
					if (!checkpoint.targetSessionFile) {
						// create 只算出公开 session 存储目录，不造 SDK AgentSession，不落空 header。
						const dir = SessionManager.create(cwd, this.sessionDir, { id: operationId }).getSessionDir();
						const copied = await this.bridge.forkWorkspace(source, { operationId, targetPath: cwd, sessionDir: dir });
						if (!copied.targetSessionFile || copied.targetSessionId !== operationId || copied.cwd !== cwd)
							throw new WorktreeError("worktree-result-unknown");
						checkpoint = {
							...initial,
							targetSessionId: copied.targetSessionId,
							targetSessionFile: copied.targetSessionFile,
							expectedModel: copied.model,
							expectedThinking: copied.thinkingLevel ?? undefined,
						};
						this.journal.checkpoint(operationId, checkpoint);
					}
					if (!checkpoint.targetSessionId || !checkpoint.targetSessionFile)
						throw new WorktreeError("worktree-result-unknown");
					await this.launcher.launch({
						operationId,
						sessionId: checkpoint.targetSessionId,
						sessionFile: checkpoint.targetSessionFile,
						cwd,
					});
					await this.verifiedTarget(checkpoint);
					return { ...checkpoint, status: "succeeded" };
				} catch (error) {
					if (error instanceof BridgeLaunchError && error.code === "launch-result-unknown")
						return { ...checkpoint, status: "unknown", code: "worktree-result-unknown" };
					if (error instanceof WorktreeError) throw error;
					if (error instanceof BridgeRequestError || error instanceof BridgeLaunchError)
						throw new WorktreeError(error.code === "unsupported" ? "bridge-unavailable" : error.code);
					throw new WorktreeError("worktree-continue-failed");
				}
			},
			retry,
		);
		return this.publicResult(result);
	}

	/** 先持久占位再启动。首条消息的 sendToken 是不透明标识，不要求客户端改成 UUID。 */
	async newSession(operationId: string, path: string): Promise<BridgeDescriptor> {
		if (!/^[A-Za-z0-9_-]{1,128}$/.test(operationId)) throw new WorktreeError("worktree-operation-invalid");
		const cwd = this.trust(path);
		const hex = createHash("sha256").update(`native-new\0${operationId}`).digest("hex");
		const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
		const old = this.journal.previous(id);
		const initial: NativeWorkspaceOperation = {
			operationId: id,
			action: "continue",
			status: "pending",
			cwd,
			targetSessionId: id,
		};
		const result = await this.journal.run(id, JSON.stringify(["new", operationId, cwd]), initial, async () => {
			if (!old && (this.bridge.descriptor(id) || SessionManager.findById(cwd, id, this.sessionDir)))
				throw new WorktreeError("worktree-operation-conflict");
			try {
				await this.launcher.launch({
					operationId: id,
					sessionId: id,
					cwd,
					newSession: true,
					sessionDir: this.sessionDir,
				});
				await this.verifiedTarget(initial);
				return { ...initial, status: "succeeded" };
			} catch (error) {
				if (error instanceof BridgeLaunchError && error.code === "launch-result-unknown")
					return { ...initial, status: "unknown", code: "worktree-result-unknown" };
				if (error instanceof WorktreeError) throw error;
				throw new WorktreeError(error instanceof BridgeLaunchError ? error.code : "worktree-continue-failed");
			}
		});
		if (result.status !== "succeeded") {
			// 上次启动结果未知时仅观察同一目标；不能通过换 ID 盲目重开。
			if (result.status === "unknown") return this.verifiedTarget(result);
			throw new WorktreeError(result.code ?? "worktree-continue-failed");
		}
		return this.verifiedTarget(result);
	}

	private resumeId(phase: string, operationId: string): string {
		if (!/^[A-Za-z0-9_-]{1,128}$/.test(operationId)) throw new WorktreeError("worktree-operation-invalid");
		const h = createHash("sha256").update(`native-resume:${phase}\0${operationId}`).digest("hex");
		return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
	}

	/** 只在明确写入意图下续原SID；unknown重试仅观察原目标，不再次启动。 */
	async resume(operationId: string, target: { id: string; path: string; cwd: string }): Promise<BridgeDescriptor> {
		const cwd = this.trust(target.cwd);
		const id = this.resumeId("start", operationId);
		if (this.bridge.descriptor(target.id)?.owner === false) throw new WorktreeError("session-owned");
		const previous = this.journal.previous(id);
		const manager = SessionManager.open(target.path, this.sessionDir);
		if (manager.getSessionId() !== target.id) throw new WorktreeError("session-not-found");
		const initial: NativeWorkspaceOperation = {
			operationId: id,
			action: "continue",
			status: "pending",
			nativeResumePhase: "start",
			targetSessionId: target.id,
			targetSessionFile: target.path,
			cwd,
		};
		const result = (await this.journal.run(
			id,
			JSON.stringify(["resume", target.id, target.path, cwd]),
			initial,
			async () => {
				if (this.bridge.descriptor(target.id)?.owner === false) throw new WorktreeError("session-owned");
				let checkpoint = initial;
				try {
					const started = await this.launcher.launch({
						operationId: id,
						sessionId: target.id,
						sessionFile: target.path,
						cwd,
					});
					const ready = { ...initial, expectedInstanceId: started.instanceId, expectedEpoch: started.epoch };
					checkpoint = ready;
					this.journal.checkpoint(id, { ...ready, status: "unknown", code: "native-start-unconfirmed" });
					await this.verifiedTarget(ready);
					return { ...ready, status: "succeeded" };
				} catch (error) {
					if (error instanceof BridgeLaunchError && error.code !== "launch-result-unknown")
						throw new WorktreeError(error.code);
					return { ...checkpoint, status: "unknown", code: "native-start-unconfirmed" };
				}
			},
			previous?.status === "failed" && previous.code === "session-owned",
		)) as NativeWorkspaceOperation;
		if (result.status === "failed") throw new WorktreeError(result.code ?? "bridge-start-failed");
		try {
			if (this.bridge.descriptor(target.id)?.owner === false) throw new WorktreeError("session-owned");
			const descriptor = await this.verifiedTarget(result);
			if (result.status === "unknown" || result.status === "pending")
				this.journal.complete(id, {
					...result,
					status: "succeeded",
					code: undefined,
					expectedInstanceId: descriptor.instanceId,
					expectedEpoch: descriptor.epoch,
				} as NativeWorkspaceOperation);
			return descriptor;
		} catch (error) {
			if (error instanceof WorktreeError && error.code === "session-owned") throw error;
			throw new WorktreeError("native-start-unconfirmed");
		}
	}

	/** 提交前持久占位；崩溃/丢ACK后只查原生收据，不把unknown当未执行。 */
	async submitResumed(
		operationId: string,
		descriptor: BridgeDescriptor,
		input: { text: string; images?: BridgeImage[]; deliverAs?: "steer" | "followUp" },
	): Promise<BridgeReply> {
		const started = this.journal.previous(this.resumeId("start", operationId)) as NativeWorkspaceOperation | undefined;
		if (
			started?.status !== "succeeded" ||
			started.expectedInstanceId !== descriptor.instanceId ||
			started.expectedEpoch !== descriptor.epoch ||
			started.targetSessionId !== descriptor.sessionId
		)
			throw new WorktreeError("native-start-unconfirmed");
		try {
			await this.verifiedTarget(started);
		} catch {
			throw new WorktreeError("native-start-unconfirmed");
		}
		const id = this.resumeId("send", operationId);
		// 日志只存指纹和收据，不持久化未提交的正文/图片。
		const digest = createHash("sha256")
			.update(
				JSON.stringify([
					descriptor.sessionId,
					descriptor.instanceId,
					descriptor.epoch,
					input.text,
					input.images ?? [],
					input.deliverAs,
				]),
			)
			.digest("hex");
		const initial: NativeWorkspaceOperation = {
			...started,
			nativeResumePhase: "send",
			operationId: id,
			status: "pending",
		};
		const previous = this.journal.previous(id);
		// 只重试扩展在记收据/调用sendUserMessage之前明确拒绝的情形。
		const retryPreflight =
			previous?.status === "failed" &&
			["busy", "compaction-busy", "session-owned", "runtime-offline"].includes(previous.code ?? "");
		let result = await this.journal.run(
			id,
			digest,
			initial,
			async () => {
				try {
					await this.bridge.send(descriptor, { operationId, ...input });
					return { ...initial, status: "succeeded" };
				} catch (error) {
					if (error instanceof BridgeRequestError) throw new WorktreeError(error.code);
					return { ...initial, status: "unknown", code: "native-submit-unconfirmed" };
				}
			},
			retryPreflight,
		);
		if (result.status === "unknown" || result.status === "pending") {
			try {
				const receipt = await this.bridge.operationStatus(descriptor, operationId);
				if (receipt.status === "submitted" || receipt.status === "settled")
					result = { ...result, status: "succeeded", code: undefined };
				else if (receipt.status === "failed")
					result = { ...result, status: "failed", code: receipt.code ?? "submission-failed" };
				if (result.status === "succeeded" || result.status === "failed") this.journal.complete(id, result);
			} catch {
				/* 原实例不可达时保留unknown，禁止重发。 */
			}
		}
		if (result.status === "failed")
			throw new BridgeRequestError(result.code ?? "submission-failed", "native submission rejected");
		if (result.status !== "succeeded") throw new WorktreeError("native-submit-unconfirmed");
		return {
			kind: "reply",
			id: operationId,
			ok: true,
			status: "submitted",
			sessionId: descriptor.sessionId,
			instanceId: descriptor.instanceId,
			epoch: descriptor.epoch,
		};
	}

	private publicResult(value: WorktreeOperation): WorktreeOperation {
		const { operationId, action, status, sessionId, targetSessionId, cwd, code, worktree } = value;
		return { operationId, action, status, sessionId, targetSessionId, cwd, code, worktree };
	}
}
