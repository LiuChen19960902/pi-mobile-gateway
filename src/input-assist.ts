// Input assistance returns metadata and edit fragments, never resource bodies or file contents.
import { accessSync, constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { DefaultResourceLoader, getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import { CombinedAutocompleteProvider } from "@earendil-works/pi-tui";
import type { PiRuntime, PiSessionLike } from "./pi-runtime.ts";
import { toWireSlashCommands, type WireSlashCommand } from "./wire.ts";

export type InputContext = { sessionId: string; cwd?: never } | { cwd: string; sessionId?: never };
export interface InputResources {
	cwd: string;
	mode: "session" | "preview";
	/** Complete effective Skills/Prompt suggestions for a loaded session;
	 * excludes extension commands by product scope, not a guarantee of execution. */
	complete: boolean;
	skillCommandsEnabled: boolean;
	commands: WireSlashCommand[];
	shadowed: Array<{ name: string; source: "skill" | "prompt"; by: "extension" | "skill" }>;
	omitted: string[];
}

export class InputAssistError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.code = code;
	}
}

export function readInputContext(frame: Record<string, unknown>): InputContext {
	const bounded = (value: unknown): value is string =>
		typeof value === "string" && value.trim().length > 0 && value.length <= 4096 && !value.includes("\0");
	if (bounded(frame.sessionId) && frame.sessionId.length <= 256 && frame.cwd === undefined) {
		return { sessionId: frame.sessionId };
	}
	if (bounded(frame.cwd) && isAbsolute(frame.cwd) && frame.sessionId === undefined) return { cwd: frame.cwd };
	throw new InputAssistError("bad-request", "requires exactly one sessionId or absolute cwd");
}

/** This flag controls suggestions; explicit /skill:name invocation remains an SDK concern. */
export function sessionInputResources(
	session: Pick<PiSessionLike, "extensionRunner" | "settingsManager" | "promptTemplates" | "resourceLoader">,
	cwd: string,
): InputResources {
	const extensions = session.extensionRunner?.getRegisteredCommands() ?? [];
	const enabled = session.settingsManager?.getEnableSkillCommands() ?? true;
	const skills = session.resourceLoader?.getSkills().skills ?? [];
	const skillNames = new Set(skills.map((skill) => `skill:${skill.name}`));
	const commands = toWireSlashCommands({
		extensions: [],
		templates: session.promptTemplates ?? [],
		skills: enabled ? skills : [],
	});
	const extensionNames = new Set(extensions.map((command) => command.invocationName));
	const shadowed: InputResources["shadowed"] = [];
	return {
		cwd,
		mode: "session",
		complete: true,
		skillCommandsEnabled: enabled,
		commands: commands.filter((command) => {
			const by = extensionNames.has(command.name)
				? "extension"
				: command.source === "prompt" && skillNames.has(command.name)
					? "skill"
					: undefined;
			if (!by) return true;
			shadowed.push({ name: command.name, source: command.source as "skill" | "prompt", by });
			return false;
		}),
		shadowed,
		omitted: [],
	};
}

/** No session is created for a home preview. Exclude packages in an in-memory
 * settings snapshot: SDK reload otherwise installs missing packages even with
 * noExtensions. Preserve each scope's paths/disable patterns and SDK precedence. */
export async function previewInputResources(cwd: string, agentDir = getAgentDir()): Promise<InputResources> {
	const source = SettingsManager.create(cwd, agentDir);
	if (source.drainErrors().length > 0) throw new InputAssistError("input-unavailable", "resource settings unavailable");
	const scopes = {
		global: { ...source.getGlobalSettings(), packages: [] },
		project: { ...source.getProjectSettings(), packages: [] },
	};
	const settings = SettingsManager.fromStorage({
		withLock: (scope, update) => {
			update(JSON.stringify(scopes[scope]));
		},
	});
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager: settings,
		noExtensions: true,
		noContextFiles: true,
		noThemes: true,
	});
	await loader.reload();
	return {
		...sessionInputResources(
			{
				settingsManager: settings,
				resourceLoader: loader,
				promptTemplates: loader.getPrompts().prompts,
			},
			cwd,
		),
		mode: "preview",
		complete: false,
		omitted: ["packages", "extensions"],
	};
}

export function findFd(): string | undefined {
	for (const dir of (process.env.PATH ?? "").split(delimiter)) {
		if (!dir) continue;
		for (const name of process.platform === "win32" ? ["fd.exe", "fdfind.exe"] : ["fd", "fdfind"]) {
			const path = join(dir, name);
			try {
				accessSync(path, constants.X_OK);
				return path;
			} catch {
				// Try the next PATH entry; queries never download executables.
			}
		}
	}
	return undefined;
}

export interface InputCompletion {
	label: string;
	path: string;
	type: "file" | "directory";
	insertText: string;
	cursorOffset: number;
	/** When editing within an existing quoted reference, avoid two closing quotes. */
	consumeClosingQuote: boolean;
}

function readAtToken(value: unknown): string {
	if (
		typeof value !== "string" ||
		(value !== "" && !/^@(?:"[^"\r\n]*"?|[^\s"]*)$/.test(value)) ||
		value.length > 2048 ||
		value.includes("\0")
	) {
		throw new InputAssistError("bad-request", "token must be the current @ fragment (at most 2048 characters)");
	}
	return value;
}

export async function completeAtToken(
	cwd: string,
	token: string,
	signal: AbortSignal,
	fdPath: string | undefined,
): Promise<{ prefix: string; items: InputCompletion[] }> {
	readAtToken(token);
	if (token === "") return { prefix: "", items: [] };
	if (!fdPath) throw new InputAssistError("input-unavailable", "fd is unavailable on the gateway");
	const provider = new CombinedAutocompleteProvider([], cwd, fdPath);
	const result = await provider.getSuggestions([token], 0, token.length, { signal });
	if (!result) return { prefix: token, items: [] };
	if (result.prefix !== token)
		throw new InputAssistError("bad-request", "token must contain only the current @ fragment");
	return {
		prefix: result.prefix,
		items: result.items.slice(0, 20).map((item) => {
			const edit = provider.applyCompletion([token], 0, token.length, item, result.prefix);
			return {
				label: item.label,
				path: item.description ?? item.label,
				type: item.label.endsWith("/") ? "directory" : "file",
				insertText: edit.lines[0],
				cursorOffset: edit.cursorCol,
				consumeClosingQuote: token.startsWith('@"') && item.value.endsWith('"'),
			};
		}),
	};
}

/** Separate lanes: loading slash resources must not cancel file completion.
 * Only the latest query in each lane can reply; close cancels outstanding fd. */
export function createInputAssist(
	runtime: Pick<PiRuntime, "inputCwd" | "inputResources">,
	send: (frame: Record<string, unknown>) => void,
	log: (message: string) => void,
	options: {
		fdPath?: string;
		timeoutMs?: number;
		resolveContext?: (
			context: InputContext,
			frame: Record<string, unknown>,
			signal: AbortSignal,
		) => Promise<{
			cwd: string;
			readResources: () => Promise<InputResources>;
			validate: () => void;
		}>;
	} = {},
) {
	const active = new Map<string, AbortController>();
	const fdPath = options.fdPath ?? findFd();
	let closed = false;
	return {
		async handle(frame: Record<string, unknown>): Promise<void> {
			const type = String(frame.type);
			const queryId = frame.queryId;
			if (closed) return;
			if (typeof queryId !== "string" || !queryId.trim() || queryId.length > 128) {
				send({
					kind: "error",
					code: "bad-request",
					message: "queryId required (at most 128 characters)",
					requestType: type,
				});
				return;
			}
			const identity =
				typeof frame.instanceId === "string" && typeof frame.epoch === "string"
					? { instanceId: frame.instanceId, epoch: frame.epoch }
					: {};
			const errorContext =
				typeof frame.sessionId === "string" && frame.sessionId.length <= 256
					? { sessionId: frame.sessionId, ...identity }
					: identity;
			let context: InputContext;
			let token = "";
			try {
				context = readInputContext(frame);
				if (type === "input-completions") token = readAtToken(frame.token);
			} catch (error) {
				send({
					kind: "error",
					code: "bad-request",
					message: String((error as Error).message),
					requestType: type,
					queryId,
					...errorContext,
				});
				return;
			}
			active.get(type)?.abort();
			const controller = new AbortController();
			active.set(type, controller);
			let resolved: Awaited<ReturnType<NonNullable<typeof options.resolveContext>>> | undefined;
			const reply = (value: Record<string, unknown>) => {
				if (closed || active.get(type) !== controller) return;
				try {
					resolved?.validate();
				} catch (error) {
					value = {
						kind: "error",
						requestType: type,
						code: error instanceof InputAssistError ? error.code : "input-unavailable",
						message: "input context changed",
						...errorContext,
					};
				}
				send({ ...value, ...identity, queryId });
			};
			const timer = setTimeout(() => {
				controller.abort();
				reply({
					kind: "error",
					code: "input-timeout",
					message: "input query timed out",
					requestType: type,
					...errorContext,
				});
				if (active.get(type) === controller) active.delete(type);
			}, options.timeoutMs ?? 3000);
			try {
				if (options.resolveContext) resolved = await options.resolveContext(context, frame, controller.signal);
				else {
					const cwd = await runtime.inputCwd(context);
					resolved = { cwd, readResources: () => runtime.inputResources(context, cwd), validate: () => {} };
				}
				resolved.validate();
				const cwd = resolved.cwd;
				if (controller.signal.aborted) return;
				if (type === "input-resources" || type === "commands") {
					const resources = await resolved.readResources();
					if (!controller.signal.aborted) reply({ kind: type, ...context, ...resources });
				} else {
					const result = await completeAtToken(cwd, token, controller.signal, fdPath);
					if (!controller.signal.aborted) reply({ kind: type, ...context, cwd, token, ...result });
				}
			} catch (error) {
				if (controller.signal.aborted) return;
				const code = error instanceof InputAssistError ? error.code : "internal";
				log(`input assistance failed: ${String(error)}`);
				reply({
					kind: "error",
					code,
					message: error instanceof InputAssistError ? error.message : "input assistance unavailable",
					requestType: type,
					...errorContext,
				});
			} finally {
				clearTimeout(timer);
				if (active.get(type) === controller) {
					active.delete(type);
				}
			}
		},
		close() {
			closed = true;
			for (const controller of active.values()) controller.abort();
			active.clear();
		},
	};
}
