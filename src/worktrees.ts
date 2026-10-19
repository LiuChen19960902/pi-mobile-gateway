import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { requireAbsoluteDirectory } from "./host-fs.ts";

const exec = promisify(execFile);
export class WorktreeError extends Error {
	readonly code: string;
	constructor(code: string) {
		super(code);
		this.code = code;
	}
}
export interface WorktreeItem {
	path: string;
	branch: string | null;
	commit: string;
	main: boolean;
	missing: boolean;
}
export interface WorktreeList {
	cwd: string;
	repoRoot: string | null;
	branch: string | null;
	suggestDir: string | null;
	dirty: boolean;
	worktrees: WorktreeItem[];
}
export function workspaceDirectory(path: string): string {
	try {
		return realpathSync(requireAbsoluteDirectory(path));
	} catch {
		throw new WorktreeError("worktree-target-unavailable");
	}
}
async function git(cwd: string, args: string[]): Promise<string> {
	try {
		return (
			await exec("git", ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-C", cwd, ...args], {
				timeout: 15_000,
				maxBuffer: 1024 * 1024,
				encoding: "utf8",
				env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
			})
		).stdout;
	} catch {
		throw new WorktreeError("worktree-git-failed");
	}
}
export async function listWorktrees(path: string): Promise<WorktreeList> {
	const cwd = workspaceDirectory(path);
	const empty: WorktreeList = { cwd, repoRoot: null, branch: null, suggestDir: null, dirty: false, worktrees: [] };
	try {
		await git(cwd, ["rev-parse", "--show-toplevel"]);
	} catch {
		return empty;
	}
	const raw = await git(cwd, ["worktree", "list", "--porcelain", "-z"]);
	const worktrees: WorktreeItem[] = [];
	let row: WorktreeItem | undefined;
	for (const token of raw.split("\0")) {
		if (token.startsWith("worktree ")) {
			const p = token.slice(9);
			row = {
				path: existsSync(p) ? realpathSync(p) : resolve(p),
				branch: null,
				commit: "",
				main: worktrees.length === 0,
				missing: !existsSync(p),
			};
			worktrees.push(row);
		} else if (row && token.startsWith("HEAD ")) row.commit = token.slice(5, 12);
		else if (row && token.startsWith("branch refs/heads/")) row.branch = token.slice(18);
		else if (row && token.startsWith("prunable")) row.missing = true;
	}
	const currentRoot = workspaceDirectory((await git(cwd, ["rev-parse", "--show-toplevel"])).trim());
	const root = worktrees[0]?.path ?? currentRoot;
	return {
		cwd,
		repoRoot: root,
		branch: worktrees.find((w) => w.path === currentRoot)?.branch ?? null,
		suggestDir: join(dirname(root), ".worktrees", basename(root)),
		dirty: (await git(cwd, ["status", "--porcelain", "-z", "--untracked-files=normal"])).length > 0,
		worktrees,
	};
}
export async function createWorktree(cwd: string, branch: string, base: string, target: string): Promise<WorktreeItem> {
	const source = await listWorktrees(cwd);
	if (!source.repoRoot) throw new WorktreeError("worktree-not-git");
	if (!isAbsolute(target) || target.includes("\0")) throw new WorktreeError("worktree-path-invalid");
	if (!branch || branch.length > 240 || branch.startsWith("-")) throw new WorktreeError("worktree-branch-invalid");
	try {
		await git(source.cwd, ["check-ref-format", "--branch", branch]);
	} catch {
		throw new WorktreeError("worktree-branch-invalid");
	}
	let commit: string;
	try {
		commit = (await git(source.cwd, ["rev-parse", "--verify", "--end-of-options", `${base}^{commit}`])).trim();
	} catch {
		let hasNoCommits = false;
		try {
			hasNoCommits = (await git(source.cwd, ["rev-list", "--all", "--max-count=1"])).trim().length === 0;
		} catch {
			// 探针失败时沿用基点错误，不把 Git 故障判断成空仓库。
		}
		if (hasNoCommits) throw new WorktreeError("worktree-no-commits");
		throw new WorktreeError("worktree-base-invalid");
	}
	const existing = source.worktrees.find((w) => w.path === resolve(target));
	if (existing) {
		throw new WorktreeError("worktree-path-exists");
	}
	if (existsSync(target)) throw new WorktreeError("worktree-path-exists");
	try {
		await git(source.cwd, ["worktree", "add", "-b", branch, "--", resolve(target), commit]);
	} catch {
		throw new WorktreeError("worktree-create-failed");
	}
	const item = (await listWorktrees(source.cwd)).worktrees.find((w) => w.path === workspaceDirectory(target));
	if (!item) throw new WorktreeError("worktree-result-unknown");
	return item;
}

export interface WorktreeOperation {
	operationId: string;
	action: "create" | "continue";
	status: "pending" | "succeeded" | "failed" | "unknown";
	sessionId?: string;
	targetSessionId?: string;
	cwd?: string;
	code?: string;
	worktree?: WorktreeItem;
}
interface RecordOnDisk {
	signature: string;
	result: WorktreeOperation;
}
/** 操作标识在断线与进程重启后保留；未知结果只能查询，不能隐式重做写操作。 */
export class WorktreeOperations {
	private readonly running = new Map<string, Promise<WorktreeOperation>>();
	private readonly dir: string;
	constructor(dir: string) {
		this.dir = dir;
	}
	private file(id: string): string {
		if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
			throw new WorktreeError("worktree-operation-invalid");
		return join(this.dir, `${id}.json`);
	}
	private read(id: string): RecordOnDisk | undefined {
		const p = this.file(id);
		if (!existsSync(p)) return undefined;
		try {
			return JSON.parse(readFileSync(p, "utf8")) as RecordOnDisk;
		} catch {
			throw new WorktreeError("worktree-result-unknown");
		}
	}
	private save(id: string, value: RecordOnDisk): void {
		mkdirSync(this.dir, { recursive: true, mode: 0o700 });
		const p = this.file(id);
		writeFileSync(`${p}.tmp`, JSON.stringify(value), { mode: 0o600 });
		renameSync(`${p}.tmp`, p);
	}
	checkpoint(id: string, patch: Partial<WorktreeOperation>): void {
		const saved = this.read(id);
		if (!saved) throw new WorktreeError("worktree-operation-not-found");
		this.save(id, { ...saved, result: { ...saved.result, ...patch } });
	}
	complete(id: string, result: WorktreeOperation): void {
		const saved = this.read(id);
		if (!saved) throw new WorktreeError("worktree-operation-not-found");
		this.save(id, { ...saved, result });
	}

	status(id: string): WorktreeOperation {
		const saved = this.read(id)?.result;
		if (!saved) throw new WorktreeError("worktree-operation-not-found");
		return saved.status === "pending" && !this.running.has(id)
			? { ...saved, status: "unknown", code: "worktree-result-unknown" }
			: saved;
	}
	previous(id: string): WorktreeOperation | undefined {
		return this.read(id)?.result;
	}
	async run(
		id: string,
		signature: string,
		initial: WorktreeOperation,
		work: () => Promise<WorktreeOperation>,
		retry = false,
	): Promise<WorktreeOperation> {
		const old = this.read(id);
		if (old && old.signature !== signature) throw new WorktreeError("worktree-operation-conflict");
		const running = this.running.get(id);
		if (running) return running;
		if (old && !(retry && old.result.status === "failed")) return this.status(id);
		this.save(id, { signature, result: { ...old?.result, ...initial, code: undefined } });
		const task = Promise.resolve()
			.then(work)
			.catch((error) => ({
				...initial,
				...this.read(id)?.result,
				status: "failed" as const,
				code: error instanceof WorktreeError ? error.code : "worktree-continue-failed",
			}))
			.then((result) => {
				this.save(id, { signature, result });
				return result;
			})
			.finally(() => this.running.delete(id));
		this.running.set(id, task);
		return task;
	}
}
