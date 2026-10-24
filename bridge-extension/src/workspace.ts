// Fork只写新目标；在源原生事件循环中同步完成，避免复制窗口穿插源CLI输入。

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { type ExtensionAPI, type ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent";
import type { BridgeErrorCode, BridgeReply, BridgeRequest } from "./protocol.ts";

export class NativeWorkspaceError extends Error {
	readonly code: BridgeErrorCode;
	constructor(code: BridgeErrorCode) {
		super(code);
		this.code = code;
	}
}
export function forkNativeWorkspace(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	root: string,
	request: Extract<BridgeRequest, { op: "worktree-fork" }>,
): Partial<BridgeReply> {
	const fail = (code: BridgeErrorCode): never => {
		throw new NativeWorkspaceError(code);
	};
	if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(request.operationId))
		return fail("worktree-operation-invalid");
	if (
		typeof request.targetPath !== "string" ||
		!isAbsolute(request.targetPath) ||
		request.targetPath.includes("\0") ||
		request.targetPath.length > 4096
	)
		return fail("worktree-target-unavailable");
	let cwd: string;
	try {
		cwd = realpathSync(request.targetPath);
		if (!statSync(cwd).isDirectory()) return fail("worktree-target-unavailable");
	} catch {
		return fail("worktree-target-unavailable");
	}
	if (
		request.sessionDir !== undefined &&
		(typeof request.sessionDir !== "string" || !isAbsolute(request.sessionDir) || request.sessionDir.includes("\0"))
	)
		return fail("worktree-target-unavailable");
	const source = ctx.sessionManager,
		sourceFile = source.getSessionFile();
	if (!sourceFile) return fail("worktree-source-empty");
	const signature = JSON.stringify([source.getSessionId(), sourceFile, cwd, request.sessionDir ?? null]);
	const receipts = join(root, "workspace-forks"),
		receipt = join(receipts, `${request.operationId}.json`);
	if (existsSync(receipt)) {
		let old: { signature: string; result: Partial<BridgeReply> };
		try {
			old = JSON.parse(readFileSync(receipt, "utf8"));
		} catch {
			return fail("worktree-result-unknown");
		}
		if (old.signature !== signature) return fail("worktree-operation-conflict");
		if (!old.result.targetSessionFile || !existsSync(old.result.targetSessionFile))
			return fail("worktree-result-unknown");
		return { ...old.result, duplicate: true };
	}
	if (!ctx.isIdle()) return fail("worktree-busy");
	if (ctx.hasPendingMessages()) return fail("worktree-queued");
	if (!existsSync(sourceFile)) return fail("worktree-source-empty");
	if (SessionManager.findById(cwd, request.operationId, request.sessionDir)) return fail("worktree-operation-conflict");
	const target = SessionManager.forkFrom(sourceFile, cwd, request.sessionDir, { id: request.operationId });
	const copied = target.getEntries(),
		entries = source.getEntries();
	if (copied.length !== entries.length || copied.some((entry, index) => entry.id !== entries[index]?.id))
		return fail("worktree-source-changed");
	const leaf = source.getLeafId();
	if (leaf && !target.getEntry(leaf)) return fail("worktree-source-changed");
	if (leaf) target.branch(leaf);
	else target.resetLeaf();
	if (ctx.model) target.appendModelChange(ctx.model.provider, ctx.model.id);
	target.appendThinkingLevelChange(pi.getThinkingLevel());
	const result: Partial<BridgeReply> = {
		targetSessionId: target.getSessionId(),
		targetSessionFile: target.getSessionFile(),
		cwd,
		leafId: target.getLeafId(),
		model: ctx.model ? { provider: ctx.model.provider, modelId: ctx.model.id } : null,
		thinkingLevel: pi.getThinkingLevel(),
	};
	mkdirSync(receipts, { recursive: true, mode: 0o700 });
	const temp = join(receipts, `${request.operationId}.${randomUUID()}.tmp`);
	writeFileSync(temp, JSON.stringify({ signature, result }), { flag: "wx", mode: 0o600 });
	renameSync(temp, receipt);
	return result;
}
