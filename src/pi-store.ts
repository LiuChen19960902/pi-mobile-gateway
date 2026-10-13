// Client-managed provider/model configuration in `~/.pi/agent/models.json`
// (pi `getModelsPath()`), served to the paired phone over the data plane.
//
// The phone's settings screen can list custom providers and upsert/delete
// them, exactly like editing models.json by hand in pi. Three rules keep this
// safe and consistent with pi's own loader:
//   - Reads are credential-blind: `providers` responses never include apiKey
//     or other secrets — the phone renders `已配置/未配置`, never the key.
//   - Writes are whole-provider upserts composed of a closed field set that
//     maps 1:1 onto pi's models.json schema (ProviderConfigSchema): the phone
//     can never smuggle arbitrary config (oauth/compat/headers/…) through.
//   - All access runs through one in-process serialization queue and writes
//     land via temp-file + atomic rename, so two gateway connections and the
//     user's own `pi` edits never observe a torn file.
//
// The reload itself is pi's job: `ModelRuntime.refresh()` re-reads models.json
// from disk and re-composes providers (provider-composer), so the gateway
// only needs to trigger it — no parsed-config caching lives here.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readProviderCatalog } from "./provider-catalog.ts";

export interface WireProviderModel {
	id: string;
	name: string | null;
	api: string | null;
	/** null inherits the provider URL; paths are never rewritten. */
	baseUrl: string | null;
	reasoning: boolean;
	input: string[];
	/** pi thinking levels this model maps explicitly; omitted keys use provider defaults. */
	thinkingLevelMap: Record<string, string | null> | null;
	contextWindow: number | null;
	maxTokens: number | null;
	/** Phone-editable compat subset; null = not set, {} = explicitly cleared. */
	compat: Record<string, boolean | string> | null;
}

export interface WireProviderInfo {
	id: string;
	/** pi display name; null falls back to the provider id (pi composer semantics). */
	name: string | null;
	baseUrl: string | null;
	/** True when an apiKey is configured. The key itself never leaves the host. */
	apiKeySet: boolean;
	/** Provider-level wire protocol (e.g. "openai-completions"). */
	api: string | null;
	models: WireProviderModel[];
}

/** Client-supplied provider definition (provider-put). Closed field set. */
export interface ProviderUpsert {
	id: string;
	name?: string;
	baseUrl?: string;
	apiKey?: string;
	/** Provider-level wire protocol; defaults to "openai-completions". */
	api?: string;
	/** Append the provider id to the global enabledModels admission list. */
	enabled?: boolean;
	/** Replaces the whole `models` array; may be empty (credential-only provider). */
	models: Array<{
		id: string;
		name?: string;
		api?: string;
		/** Omitted preserves the host override; null explicitly restores inheritance. */
		baseUrl?: string | null;
		reasoning?: boolean;
		input?: Array<"text" | "image">;
		thinkingLevelMap?: Record<string, string | null>;
		contextWindow?: number;
		maxTokens?: number;
		/** Present (even empty) means authoritative: replaces the prior compat entirely. */
		compat?: Record<string, unknown>;
	}>;
}

/** Client-facing validation failure; the router echoes the message. */
export class ProviderConfigError extends Error {}

const PI_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const MODEL_INPUT = ["text", "image"] as const;
const MAXIMUM_MODELS = 256;
const MAXIMUM_ID_LENGTH = 128;

interface RawModelsConfig {
	providers?: Record<string, Record<string, unknown>>;
}

function asTrimmedString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed === "" ? undefined : trimmed;
}

function asPositiveInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

/** Phone-editable compat subset: booleans plus pi's string enums for custom
 * providers. Nested objects (chatTemplateKwargs, routing, …) stay host-managed:
 * put() preserves them but the wire never carries them. */
const COMPAT_BOOLEAN_KEYS = new Set([
	"supportsStore",
	"supportsDeveloperRole",
	"supportsReasoningEffort",
	"supportsUsageInStreaming",
	"supportsFinishReason",
	"requiresToolResultName",
	"requiresAssistantAfterToolResult",
	"requiresThinkingAsText",
	"requiresReasoningContentOnAssistantMessages",
	"zaiToolStream",
	"supportsThinkingTokenBudget",
	"supportsOpenAIGrammarTools",
	"supportsStrictMode",
	"supportsStrictTools",
	"supportsTemperature",
	"supportsCacheControlOnTools",
	"supportsEagerToolInputStreaming",
	"supportsLongCacheRetention",
	"sendSessionAffinityHeaders",
	"supportsAdditionalTools",
	"supportsToolSearch",
	"supportsExplicitPromptCacheMode",
	"supportsToolReferences",
	"forceAdaptiveThinking",
	"allowEmptySignature",
]);

const COMPAT_ENUMS: Record<string, readonly string[]> = {
	maxTokensField: ["max_completion_tokens", "max_tokens"],
	thinkingFormat: [
		"openai",
		"openrouter",
		"deepseek",
		"together",
		"baseten",
		"zai",
		"qwen",
		"chat-template",
		"qwen-chat-template",
		"string-thinking",
		"ant-ling",
	],
	thinkingTokenBudgetField: ["thinking_token_budget", "thinking_budget", "thinking_budget_tokens"],
	cacheControlFormat: ["anthropic"],
	deferredToolsMode: ["kimi"],
	sessionAffinityFormat: ["openai", "openai-nosession", "openrouter"],
};

/** Normalize a compat object to the phone-editable subset. Non-objects (incl.
 * absent) yield undefined; known keys are type-checked, unknown keys are
 * dropped from the wire (they survive host-side via the put merge). */
function normalizeCompat(raw: unknown): Record<string, boolean | string> | undefined {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
	const managed: Record<string, boolean | string> = {};
	for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
		if (value === null) continue; // phone sends explicit null = restore default (absent)
		if (COMPAT_BOOLEAN_KEYS.has(key)) {
			if (typeof value !== "boolean") throw new ProviderConfigError(`compat.${key} 必须是布尔值`);
			managed[key] = value;
		} else if (key in COMPAT_ENUMS) {
			if (typeof value !== "string" || !(COMPAT_ENUMS[key] as readonly string[]).includes(value)) {
				throw new ProviderConfigError(`compat.${key} 取值无效（${COMPAT_ENUMS[key].join(" / ")}）`);
			}
			managed[key] = value;
		}
	}
	return managed;
}

/** Normalize a raw thinkingLevelMap: keep only pi levels, trim string targets,
 * treat null as "unsupported", drop the entry when nothing meaningful remains. */
function normalizeThinkingLevelMap(raw: unknown): Record<string, string | null> | null | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const mapped: Record<string, string | null> = {};
	for (const level of PI_THINKING_LEVELS) {
		const value = (raw as Record<string, unknown>)[level];
		if (value === null) mapped[level] = null;
		else if (typeof value === "string" && value.trim() !== "") mapped[level] = value.trim();
	}
	return Object.keys(mapped).length > 0 ? mapped : null;
}
/** Project one raw models.json provider entry to the credential-blind wire shape. */
function toWireModel(raw: Record<string, unknown>): WireProviderModel | undefined {
	const id = asTrimmedString(raw.id);
	if (!id) return undefined;
	const input = Array.isArray(raw.input)
		? raw.input.filter(
				(entry): entry is string => typeof entry === "string" && (MODEL_INPUT as readonly string[]).includes(entry),
			)
		: [];
	return {
		id,
		name: asTrimmedString(raw.name) ?? null,
		api: asTrimmedString(raw.api) ?? null,
		baseUrl: asTrimmedString(raw.baseUrl) ?? null,
		reasoning: raw.reasoning === true,
		input,
		thinkingLevelMap: normalizeThinkingLevelMap(raw.thinkingLevelMap) ?? null,
		contextWindow: asPositiveInteger(raw.contextWindow) ?? null,
		maxTokens: asPositiveInteger(raw.maxTokens) ?? null,
		compat: normalizeCompat(raw.compat) ?? null,
	};
}

function toWireProvider(id: string, raw: Record<string, unknown>): WireProviderInfo {
	const models: WireProviderModel[] = [];
	const rawModels = Array.isArray(raw.models) ? raw.models : [];
	for (const entry of rawModels.slice(0, MAXIMUM_MODELS)) {
		if (typeof entry !== "object" || entry === null) continue;
		const model = toWireModel(entry as Record<string, unknown>);
		if (model) models.push(model);
	}
	models.sort((a, b) => a.id.localeCompare(b.id));
	return {
		id,
		name: asTrimmedString(raw.name) ?? null,
		baseUrl: asTrimmedString(raw.baseUrl) ?? null,
		apiKeySet: typeof raw.apiKey === "string" && raw.apiKey.trim() !== "",
		api: asTrimmedString(raw.api) ?? null,
		models,
	};
}

/** 归一化后的 provider 定义：`models` 已逐条校验，其余托管字段缺省即“清除”。 */
interface NormalizedProviderDefinition {
	name?: string;
	baseUrl?: string;
	apiKey?: string;
	api?: string;
	models: Array<Record<string, unknown>>;
}

/** Validate and shape the client's upsert into models.json provider fields.
 * Every failure message is client-safe (no paths, no secrets). */
export function normalizeProviderUpsert(input: ProviderUpsert): {
	id: string;
	definition: NormalizedProviderDefinition;
} {
	const id = asTrimmedString(input.id);
	if (id === undefined) throw new ProviderConfigError("provider id 不能为空");
	if (id.length > MAXIMUM_ID_LENGTH) throw new ProviderConfigError("provider id 过长");
	if (id.includes("/")) throw new ProviderConfigError("provider id 不能包含 /");
	const name = asTrimmedString(input.name);
	if (name !== undefined && name.length > MAXIMUM_ID_LENGTH) throw new ProviderConfigError("provider name 过长");
	const baseUrl = asTrimmedString(input.baseUrl);
	if (baseUrl !== undefined && !(baseUrl.startsWith("http://") || baseUrl.startsWith("https://"))) {
		throw new ProviderConfigError("baseUrl 必须是 http:// 或 https:// 地址");
	}
	const apiKey = asTrimmedString(input.apiKey);
	const rawModels = Array.isArray(input.models) ? input.models : [];
	// 空 models 合法：pi 允许 provider 仅带凭据（模型后续补或走目录刷新）。
	if (rawModels.length > MAXIMUM_MODELS) throw new ProviderConfigError(`模型数量不能超过 ${MAXIMUM_MODELS}`);
	const models = rawModels.map((raw) => {
		const entry = (raw ?? {}) as ProviderUpsert["models"][number];
		const modelId = asTrimmedString(entry.id);
		if (modelId === undefined) throw new ProviderConfigError("模型 id 不能为空");
		if (modelId.length > MAXIMUM_ID_LENGTH) throw new ProviderConfigError("模型 id 过长");
		const definition: Record<string, unknown> = { id: modelId };
		const modelName = asTrimmedString(entry.name);
		if (modelName !== undefined) definition.name = modelName;
		const api = asTrimmedString(entry.api);
		if (api !== undefined) {
			if (api.length > MAXIMUM_ID_LENGTH) throw new ProviderConfigError("api 协议名过长");
			definition.api = api;
		}
		if (entry.baseUrl === null) definition.baseUrl = null;
		else if (entry.baseUrl !== undefined) {
			const modelBaseUrl = asTrimmedString(entry.baseUrl);
			if (!modelBaseUrl || !/^https?:\/\//.test(modelBaseUrl)) {
				throw new ProviderConfigError(`${modelId}: baseUrl 必须是 http(s) 地址或null`);
			}
			definition.baseUrl = modelBaseUrl;
		}
		if (typeof entry.reasoning === "boolean") definition.reasoning = entry.reasoning;
		const input = Array.isArray(entry.input)
			? entry.input.filter((item): item is "text" | "image" => (MODEL_INPUT as readonly string[]).includes(item))
			: undefined;
		if (input !== undefined && input.length > 0) definition.input = [...new Set(input)];
		const thinkingLevelMap = normalizeThinkingLevelMap(entry.thinkingLevelMap);
		if (thinkingLevelMap) definition.thinkingLevelMap = thinkingLevelMap;
		if (entry.compat !== undefined) {
			if (typeof entry.compat !== "object" || entry.compat === null) {
				throw new ProviderConfigError("compat 必须是对象");
			}
			definition.compat = normalizeCompat(entry.compat) ?? {};
		}
		const contextWindow = asPositiveInteger(entry.contextWindow);
		if (contextWindow !== undefined) definition.contextWindow = contextWindow;
		const maxTokens = asPositiveInteger(entry.maxTokens);
		if (maxTokens !== undefined) definition.maxTokens = maxTokens;
		return definition;
	});
	const ids = new Set(models.map((model) => String(model.id)));
	if (ids.size !== models.length) throw new ProviderConfigError("模型 id 重复");
	const definition: NormalizedProviderDefinition = { models };
	if (name !== undefined) definition.name = name;
	if (baseUrl !== undefined) definition.baseUrl = baseUrl;
	if (apiKey !== undefined) definition.apiKey = apiKey;
	if (input.api !== undefined) definition.api = input.api;
	return { id, definition };
}

/**
 * Read/write service over pi's models.json. `path` is injectable for tests;
 * production resolves it lazily via pi `getModelsPath()` (`~/.pi/agent/models.json`).
 */
export class PiProviderStore {
	/** Resolved models.json path; empty means resolve lazily via pi (tests pin a temp path). */
	private readonly overridePath: string | undefined;
	/** All store operations share one in-process chain: serialized access
	 * without any lock dependency (matches the host's single-process reality). */
	private queue: Promise<unknown> = Promise.resolve();

	constructor(options: { path?: string } = {}) {
		this.overridePath = options.path;
	}

	/** 原始 provider 条目（**含 apiKey**）——仅供网关内部使用（provider-test 用已存
	 *  凭据发测试请求，手机无须重填 key）。对外协议始终走 [list] 的凭据盲投影。 */
	raw(id: string): Promise<Record<string, unknown> | undefined> {
		return this.enqueue(() => {
			const entry = this.read().providers?.[id];
			return typeof entry === "object" && entry !== null
				? (structuredClone(entry) as Record<string, unknown>)
				: undefined;
		});
	}

	/** Credential-blind snapshot of every provider the phone may manage. */
	list(): Promise<WireProviderInfo[]> {
		return this.enqueue(() => {
			const raw = this.read();
			const providers: WireProviderInfo[] = [];
			for (const [id, entry] of Object.entries(raw.providers ?? {})) {
				if (typeof entry !== "object" || entry === null) continue;
				providers.push(toWireProvider(id, entry));
			}
			providers.sort((a, b) => a.id.localeCompare(b.id));
			return providers;
		});
	}

	listCatalog() {
		return readProviderCatalog(join(dirname(this.modelsPath()), "models-store.json"));
	}

	/** Replace (or create) one provider wholesale; preserves sibling providers.
	 * The phone speaks a closed field set and is credential-blind, so the
	 * previous definition's apiKey and host-managed extras (compat, cost, …)
	 * are preserved: managed fields always follow the upsert (absent means
	 * cleared), per-model extras survive by model id when the model is re-sent. */
	put(upsert: ProviderUpsert): Promise<{ provider: WireProviderInfo; removedModelIds: string[] }> {
		const { id, definition } = normalizeProviderUpsert(upsert);
		return this.enqueue(() => {
			const previous = this.read();
			const providers: Record<string, Record<string, unknown>> = { ...(previous.providers ?? {}) };
			const prior = providers[id];
			const merged: Record<string, unknown> = { ...prior };
			for (const field of ["name", "baseUrl", "api"] as const) {
				if (definition[field] !== undefined) merged[field] = definition[field];
				// 缺省保留原值：没填的字段不动，只按显式发送的覆盖。
			}
			if (definition.apiKey !== undefined) merged.apiKey = definition.apiKey;
			const previousModels = Array.isArray(prior?.models) ? (prior?.models as Array<Record<string, unknown>>) : [];
			merged.models = definition.models.map((model) => {
				const priorModel = previousModels.find((entry) => entry && entry.id === model.id);
				const mergedModel: Record<string, unknown> = priorModel ? { ...priorModel, ...model } : { ...model };
				if (model.baseUrl === null) delete mergedModel.baseUrl;
				// compat deep-merge: the phone is authoritative for the editable
				// key subset; host-only keys (nested objects) survive the edit.
				const phoneCompat =
					typeof model.compat === "object" && model.compat !== null
						? (model.compat as Record<string, unknown>)
						: undefined;
				if (phoneCompat !== undefined) {
					const priorCompat =
						typeof priorModel?.compat === "object" && priorModel?.compat !== null
							? (priorModel.compat as Record<string, unknown>)
							: {};
					const editableKeys = new Set([...COMPAT_BOOLEAN_KEYS, ...Object.keys(COMPAT_ENUMS)]);
					const hostOnlyPrior = Object.fromEntries(
						Object.entries(priorCompat).filter(([key]) => !editableKeys.has(key)),
					);
					const combined: Record<string, unknown> = { ...hostOnlyPrior, ...phoneCompat };
					if (Object.keys(combined).length === 0) delete mergedModel.compat;
					else mergedModel.compat = combined;
				}
				if (
					typeof mergedModel.compat === "object" &&
					mergedModel.compat !== null &&
					Object.keys(mergedModel.compat).length === 0
				) {
					delete mergedModel.compat;
				}
				return mergedModel;
			});
			providers[id] = merged;
			this.write({ ...previous, providers });
			// 手机端编辑 provider 时删掉的模型行：它们在 models.json 里已经没了，
			// 调用方要据此清掉 settings.enabledModels 里对应的具体 pattern，
			// 否则死 pattern 永久残留（实测残留过 relayA/<模型名>）。
			const keptIds = new Set(definition.models.map((model) => model.id));
			const removedModelIds = previousModels
				.map((entry) => (typeof entry?.id === "string" ? entry.id : ""))
				.filter((modelId) => modelId !== "" && !keptIds.has(modelId));
			return { provider: toWireProvider(id, merged), removedModelIds };
		});
	}

	/** Delete one provider; deleting an unknown id is a client error. */
	remove(id: string): Promise<void> {
		const providerId = (id ?? "").trim();
		if (!providerId) throw new ProviderConfigError("provider id 不能为空");
		return this.enqueue(() => {
			const previous = this.read();
			const providers: Record<string, Record<string, unknown>> = { ...(previous.providers ?? {}) };
			if (!(providerId in providers)) throw new ProviderConfigError(`provider 不存在: ${providerId}`);
			delete providers[providerId];
			this.write({ ...previous, providers });
		});
	}

	private enqueue<T>(operation: () => T): Promise<T> {
		const run = this.queue.then(operation, operation);
		this.queue = run.catch(() => undefined);
		return run;
	}

	private modelsPath(): string {
		return this.overridePath ?? join(getAgentDir(), "models.json");
	}

	private read(): RawModelsConfig {
		try {
			const parsed: unknown = JSON.parse(readFileSync(this.modelsPath(), "utf8"));
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
			return parsed as RawModelsConfig;
		} catch (error) {
			if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return {};
			throw new ProviderConfigError("models.json 读取失败，请检查文件格式");
		}
	}

	private write(config: RawModelsConfig): void {
		const path = this.modelsPath();
		try {
			mkdirSync(dirname(path), { recursive: true });
			// Temp file + rename: readers (pi, other connections) never see a torn file.
			const temporaryPath = `${path}.tmp-${process.pid}-${Date.now()}`;
			writeFileSync(temporaryPath, `${JSON.stringify(config, null, "\t")}\n`, "utf8");
			renameSync(temporaryPath, path);
		} catch {
			throw new ProviderConfigError("models.json 写入失败");
		}
	}
}
