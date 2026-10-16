// Host filesystem services behind the client's workspace picker: a read-only
// directory listing plus two explicit, narrow creation commands. Every path
// crossing this module must be absolute; listing exposes subdirectories only.
// The requests arrive exclusively from token-authenticated devices, and the
// picker is the only way a client can name a cwd for a new pi session.

import { mkdirSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";

export interface WireDirectoryItem {
	name: string;
	path: string;
	hidden: boolean;
}

export interface DirectoryListing {
	path: string;
	home: string;
	crumbs: WireDirectoryItem[];
	entries: WireDirectoryItem[];
	truncated: boolean;
}

export interface DirectoryCreation {
	path: string;
	created: boolean;
}

export interface WorkspaceInfo {
	workspaceId: string;
	path: string;
	title: string;
	/** 客户端契约必填（GatewayWorkspace），新建工作区尚无挂载会话。 */
	sessionIds: string[];
	createdAt: string;
	updatedAt: string;
}

const MAXIMUM_ENTRIES = 500;

/** Client-facing validation failure; the router echoes the message. */
export class DirectoryError extends Error {
	readonly code: string;
	constructor(message: string, code = "bad-request") {
		super(message);
		this.code = code;
	}
}

/** Only stable categories cross the wire; never include OS messages or paths. */
export function classifyDirectoryError(error: unknown): DirectoryError | null {
	if (error instanceof DirectoryError) return error;
	const code = (error as NodeJS.ErrnoException | null)?.code;
	switch (code) {
		case "EACCES":
		case "EPERM":
			return new DirectoryError("没有目录访问权限", "directory-permission-denied");
		case "ENOENT":
			return new DirectoryError("目录不存在", "directory-not-found");
		case "ENOTDIR":
			return new DirectoryError("路径不是目录", "directory-not-directory");
		case "EEXIST":
			return new DirectoryError("同名条目已存在", "directory-name-conflict");
		case "EROFS":
			return new DirectoryError("目录只读", "filesystem-read-only");
		case "ENOSPC":
		case "EDQUOT":
			return new DirectoryError("宿主存储空间不足", "storage-full");
		default:
			return null;
	}
}

export function requireAbsoluteDirectory(path: string): string {
	if (!isAbsolute(path)) throw new DirectoryError("path 必须是绝对路径");
	const resolved = resolve(path);
	let stat: import("node:fs").Stats;
	try {
		stat = statSync(resolved);
	} catch (error) {
		throw classifyDirectoryError(error) ?? error;
	}
	if (!stat.isDirectory()) throw new DirectoryError("路径不是目录", "directory-not-directory");
	return resolved;
}

/** Breadcrumb chain from the filesystem root down to `path`, inclusive —
 * the client derives the parent directory from the second-to-last crumb. */
function buildCrumbs(resolved: string): WireDirectoryItem[] {
	const crumbs: WireDirectoryItem[] = [{ name: "/", path: "/", hidden: false }];
	if (resolved === "/") return crumbs;
	let accumulated = "";
	for (const segment of resolved.split("/").filter(Boolean)) {
		accumulated += `/${segment}`;
		crumbs.push({ name: segment, path: accumulated, hidden: segment.startsWith(".") });
	}
	return crumbs;
}

export function listDirectories(rawPath: string | undefined): DirectoryListing {
	const home = homedir();
	const target = requireAbsoluteDirectory(rawPath !== undefined ? rawPath : home);
	const entries: WireDirectoryItem[] = [];
	for (const name of readdirSync(target)) {
		let stat: import("node:fs").Stats;
		try {
			stat = statSync(join(target, name));
		} catch {
			continue; // raced removal / permission hole: skip quietly
		}
		if (!stat.isDirectory()) continue;
		entries.push({ name, path: join(target, name), hidden: name.startsWith(".") });
	}
	entries.sort((a, b) => a.name.localeCompare(b.name));
	const truncated = entries.length > MAXIMUM_ENTRIES;
	return {
		path: target,
		home,
		crumbs: buildCrumbs(target),
		entries: truncated ? entries.slice(0, MAXIMUM_ENTRIES) : entries,
		truncated,
	};
}

function validDirectoryName(rawName: unknown): string {
	if (typeof rawName !== "string" || rawName.trim() === "") {
		throw new DirectoryError("文件夹名称不能为空", "directory-name-invalid");
	}
	const trimmed = rawName.trim();
	if (trimmed === "." || trimmed === ".." || trimmed.includes("/") || trimmed.includes("\\")) {
		throw new DirectoryError("文件夹名称不合法", "directory-name-invalid");
	}
	return trimmed;
}

export function createDirectory(rawParent: string, rawName: string): DirectoryCreation {
	const parent = requireAbsoluteDirectory(rawParent);
	const name = validDirectoryName(rawName);
	const target = join(parent, name);
	let stat: import("node:fs").Stats;
	try {
		stat = statSync(target);
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
		mkdirSync(target);
		return { path: target, created: true };
	}
	if (!stat.isDirectory()) throw new DirectoryError("同名条目已存在", "directory-name-conflict");
	return { path: target, created: false };
}

export function createWorkspaceAt(rawPath: string): WorkspaceInfo {
	if (typeof rawPath !== "string" || !isAbsolute(rawPath)) {
		throw new DirectoryError("path 必须是绝对路径");
	}
	const resolved = resolve(rawPath);
	try {
		mkdirSync(resolved, { recursive: true });
	} catch (error) {
		// 已存在文件时 recursive 直接抛 EEXIST：透下去由 stat 判“不是目录”，走 DirectoryError 而非 internal。
		if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
	}
	const stat = statSync(resolved);
	if (!stat.isDirectory()) throw new DirectoryError("路径不是目录", "directory-not-directory");
	const now = new Date().toISOString();
	return {
		workspaceId: resolved,
		path: resolved,
		title: basename(resolved) || resolved,
		sessionIds: [],
		createdAt: now,
		updatedAt: now,
	};
}
