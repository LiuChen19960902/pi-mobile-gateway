// provider 连接测试与健康状态。
//
// 目的：手机端把 provider 写进 models.json 后，用户在此之前无从知道配置对不对
// ——baseUrl 少一段路径（如 `/v1`）时上游会把首页 HTML 当成成功响应返回，pi 直到
// 真正对话才报 “Stream ended without finish_reason”，用户完全看不出原因。
//
// 两条铁律：
//   1. **复刻 pi 的请求方式**，否则测试结果不代表 pi 能否工作。pi 的
//      `openai-completions` 走 OpenAI SDK，URL 为 `new URL(baseURL + "/chat/completions")`
//      （SDK 仅在 baseURL 以 `/` 结尾时去掉 path 首斜杠），因此 baseUrl 必须自带
//      `/v1` 之类路径段。这里逐字对齐该拼接。
//   2. **只做只读探测**：发一条最小对话请求（`TEST_MAX_TOKENS` 条输出），不流式、
//      不跟随重定向、有超时与响应体上限。
//
// 测试结果持久化在网关自己的文件（不动 models.json，也不影响 pi/TUI）：只有
// 「测过且失败」才算未激活；没有记录的 provider（例如用户在电脑上手工添加的）
// 一律视为激活，避免把既有配置隐藏掉。

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** 失败类型：`config` = 可判定的配置问题（非法 URL、认证被拒、HTTP 端点不存在、网页响应等）；
 *  `transient` = 超时/5xx/429/网络失败，**不得因此禁用 provider**；DNS 失败本身不足以确定配置错误。
 *  实测教训：中转站响应从 2s 到 >12s 波动，把超时当配置错会让“配置正确”的
 *  provider 反复变灰（模型从选择器消失）。 */
export type ProviderFailureKind = "config" | "transient";

/** 单次测试的结论。`error` 是可直接展示给用户的中文说明。 */
export interface ProviderTestResult {
	ok: boolean;
	latencyMs: number;
	/** 上游 HTTP 状态码（网络层失败时缺省）。 */
	httpStatus?: number;
	/** 实际请求的 URL，失败时回显给用户定位配置问题。 */
	url?: string;
	error?: string;
	/** 失败归因；`ok:true` 时缺省。 */
	failureKind?: ProviderFailureKind;
}

export interface ProviderTestInput {
	baseUrl: string;
	apiKey?: string;
	/** pi 模型级协议（`model.api`）；缺省按 openai-completions 处理。 */
	api?: string;
	modelId: string;
}

const TEST_TIMEOUT_MS = 12_000;

/**
 * 复刻 OpenAI SDK 的 URL 拼接：`baseURL + path`，仅当两者在交界处都有斜杠时去掉
 * path 的首斜杠（见 openai/client.js `buildURL`）。注意**各协议 baseUrl 语义不同**：
 * openai 系要 baseUrl 自带 `/v1`，anthropic 由 SDK 拼 `/v1/messages`（baseUrl 不含
 * `/v1`），google 的 baseUrl 已含版本段。测试与之一致才能保证结论代表 pi 的真实行为。
 */
export function joinProviderUrl(baseUrl: string, path: string): string {
	const joined = baseUrl.endsWith("/") && path.startsWith("/") ? `${baseUrl}${path.slice(1)}` : `${baseUrl}${path}`;
	return new URL(joined).toString();
}

/** 不把所有协议的404都误导成“少了/v1”。不修改配置或请求路径。 */
function endpointHint(baseUrl: string, api: string | undefined): string {
	if (api === "anthropic-messages") {
		return /\/v1\/?$/.test(baseUrl)
			? "Anthropic协议会追加/v1，请检查该模型的Base URL是否重复包含/v1"
			: "请检查该模型的Base URL与Anthropic协议是否匹配";
	}
	return "请检查该模型的Base URL和协议；OpenAI兼容地址通常需要/v1等路径段";
}

const TEST_MAX_TOKENS = 16;
/** 响应体读取上限（流式读取，读到上限即断开，避免把大文件全量缓冲进内存）。 */
const MAX_BODY_BYTES = 64 * 1024;
/** 模型清单可能很大（聚合中转几百个模型），单独放宽上限：截断会让 JSON 解析失败，
 * 反而被误报成「上游返回里没有可解析的模型 id」。 */
const MODELS_MAX_BODY_BYTES = 1024 * 1024;

/** 测试用的端点与请求：与 pi 各协议的 `model.api` 对应。 */
function testRequest(input: ProviderTestInput): { url: string; headers: Record<string, string>; body: unknown } {
	const api = input.api ?? "openai-completions";
	const key = input.apiKey ?? "";
	if (api === "anthropic-messages") {
		// Anthropic SDK 自己拼 `/v1/messages`（客户端 baseURL 不含 /v1），与 openai 系
		// 的 baseUrl 语义不同——这里必须逐字复刻，否则对合法 anthropic 配置误报 404。
		return {
			url: joinProviderUrl(input.baseUrl, "/v1/messages"),
			headers: {
				"content-type": "application/json",
				"x-api-key": key,
				"anthropic-version": "2023-06-01",
			},
			body: { model: input.modelId, max_tokens: TEST_MAX_TOKENS, messages: [{ role: "user", content: "ping" }] },
		};
	}
	if (api === "google-generative-ai") {
		return {
			url: joinProviderUrl(input.baseUrl, `/models/${encodeURIComponent(input.modelId)}:generateContent`),
			headers: { "content-type": "application/json", "x-goog-api-key": key },
			body: { contents: [{ parts: [{ text: "ping" }] }] },
		};
	}
	if (api === "openai-responses") {
		// pi 的 Responses 实现使用 input/max_output_tokens，不能拿 Chat Completions
		// 端点替代探测；这里只关闭流式，其余保持同协议的最小合法请求。
		return {
			url: joinProviderUrl(input.baseUrl, "/responses"),
			headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
			body: {
				model: input.modelId,
				input: [{ role: "user", content: [{ type: "input_text", text: "ping" }] }],
				max_output_tokens: TEST_MAX_TOKENS,
				store: false,
			},
		};
	}
	// openai-completions 及未知协议：按 OpenAI 兼容端点测试。
	return {
		url: joinProviderUrl(input.baseUrl, "/chat/completions"),
		headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
		body: { model: input.modelId, max_tokens: TEST_MAX_TOKENS, messages: [{ role: "user", content: "ping" }] },
	};
}

/** 判定“响应像不像 API 应答”，并直接从 body 里判定“是不是错误响应”。
 *  HTML/纯文本要单独给提示——这正是 baseUrl 少路径段时的典型症状（中转站把首页
 *  200 返回给任意路径）；`error` 键存在即视为失败（兼容 `{"error":"str"}` 与
 *  `{"error":{"code":500}}` 这类无 message 的形态）。 */
function describeBody(body: string): { kind: "json" | "html" | "text"; error?: string } {
	const trimmed = body.trim();
	if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
		try {
			const parsed: unknown = JSON.parse(trimmed);
			if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
				const record = parsed as Record<string, unknown>;
				if ("error" in record && record.error !== null && record.error !== undefined) {
					return { kind: "json", error: extractUpstreamMessage(trimmed) ?? "上游返回 error 响应" };
				}
				return { kind: "json" };
			}
			if (Array.isArray(parsed)) return { kind: "json" };
		} catch {
			return { kind: "text", error: "响应不是合法 JSON" };
		}
	}
	if (/^\s*<(!doctype|html|\?xml)/i.test(trimmed)) return { kind: "html" };
	return { kind: "text" };
}

/** 读取响应体到上限（流式 + 主动 cancel）：`response.text()` 会把整个 body 读进
 *  内存，配置笔误指向大文件端点时可能造成瞬时内存尖峰。 */
async function readBodyCapped(response: Response, limit: number): Promise<string> {
	const body = response.body;
	if (!body) return "";
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			chunks.push(value);
			total += value.byteLength;
			if (total >= limit) break;
		}
	} finally {
		// 到上限主动断流；已读部分足够判定响应形态。
		await reader.cancel().catch(() => undefined);
	}
	const merged = new Uint8Array(Math.min(total, limit));
	let offset = 0;
	for (const chunk of chunks) {
		const take = Math.min(chunk.byteLength, merged.byteLength - offset);
		if (take <= 0) break;
		merged.set(chunk.subarray(0, take), offset);
		offset += take;
	}
	return new TextDecoder().decode(merged);
}

/** 从错误响应里提取可直接展示的上游说明（OpenAI `{error:{message}}` / 通用 `{message}`）。 */
function extractUpstreamMessage(body: string): string | undefined {
	try {
		const parsed: unknown = JSON.parse(body);
		if (typeof parsed !== "object" || parsed === null) return undefined;
		const record = parsed as Record<string, unknown>;
		const error = record.error;
		if (typeof error === "object" && error !== null) {
			const message = (error as Record<string, unknown>).message;
			if (typeof message === "string" && message.trim() !== "") return message;
		}
		if (typeof record.message === "string" && record.message.trim() !== "") return record.message;
	} catch {
		// 非 JSON：交给调用方按状态码给通用说明。
	}
	return undefined;
}

/**
 * 用已存/表单提供的凭据探测一个 provider。永不抛错——所有失败都折算成
 * `{ ok:false, error }`，因为调用方要把结论回给手机端展示。
 */
export async function testProvider(input: ProviderTestInput): Promise<ProviderTestResult> {
	const startedAt = Date.now();
	const latency = () => Date.now() - startedAt;
	if (!/^https?:\/\//.test(input.baseUrl)) {
		return { ok: false, latencyMs: 0, error: "Base URL 必须是 http(s) 地址" };
	}
	if (input.modelId.trim() === "") {
		return { ok: false, latencyMs: 0, error: "需要至少一个模型 id 才能测试连接" };
	}
	let request: ReturnType<typeof testRequest>;
	try {
		request = testRequest(input);
	} catch {
		return { ok: false, latencyMs: latency(), error: "Base URL 不是合法地址" };
	}

	try {
		const response = await fetch(request.url, {
			method: "POST",
			headers: request.headers,
			body: JSON.stringify(request.body),
			// 探测不应被重定向到别处（中转常见 302 到登录页）。
			redirect: "manual",
			signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
		});
		const text = await readBodyCapped(response, MAX_BODY_BYTES);
		const status = response.status;

		if (status >= 300 && status < 400) {
			return {
				ok: false,
				failureKind: "config",
				latencyMs: latency(),
				httpStatus: status,
				url: request.url,
				error: `上游返回重定向（HTTP ${status}）→ ${response.headers.get("location") ?? "未知地址"}，请确认 baseUrl 是否少了路径段`,
			};
		}
		const shape = describeBody(text);
		if (!response.ok) {
			const upstream = extractUpstreamMessage(text);
			// 5xx / 429 是上游自身问题（含限流、过载）：不得因此禁用 provider。
			const transient = status >= 500 || status === 429;
			const hint =
				status === 401 || status === 403
					? "认证失败，请检查 API Key"
					: status === 404
						? `端点不存在（${request.url}），${endpointHint(input.baseUrl, input.api)}`
						: transient
							? "上游暂时不可用（稍后重试即可，配置本身可能没问题）"
							: "上游返回错误";
			return {
				ok: false,
				failureKind: transient ? "transient" : "config",
				latencyMs: latency(),
				httpStatus: status,
				url: request.url,
				error: `${hint}${upstream ? `：${upstream}` : `（HTTP ${status}）`}`,
			};
		}
		if (shape.error) {
			return {
				ok: false,
				failureKind: "config",
				latencyMs: latency(),
				httpStatus: status,
				url: request.url,
				error: shape.error,
			};
		}
		if (shape.kind !== "json") {
			return {
				ok: false,
				failureKind: "config",
				latencyMs: latency(),
				httpStatus: status,
				url: request.url,
				error:
					shape.kind === "html"
						? `该地址返回的是网页而不是 API 响应（${request.url}）——常见原因是 baseUrl 少了 /v1 等路径段，或填成了站点首页`
						: `该地址返回的不是 JSON API 响应（${request.url}），请检查 baseUrl`,
			};
		}
		// 错误响应已在 describeBody 里按 `error` 键统一判定（含 `{"error":"str"}`
		// 与无 message 的错误体），这里不再做子串猜测：否则带顶层 `message` 字段的
		// 正常响应会被误判为失败。
		return { ok: true, latencyMs: latency(), httpStatus: status, url: request.url };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const timedOut = /abort|timeout/i.test(message);
		return {
			ok: false,
			// 已通过地址与参数校验；请求/读响应阶段的连接中断与超时都不能
			// 证明配置错误。与模型拉取一致，避免一次网络波动禁用 provider。
			failureKind: "transient",
			latencyMs: latency(),
			url: request.url,
			error: timedOut
				? `连接超时（${TEST_TIMEOUT_MS / 1000}s，上游较慢时可稍后重试，不代表配置错误）：${message}`
				: `无法连接到该地址：${message}`,
		};
	}
}

/** 持久化的单条测试结论。 */
export interface ProviderModelsInput {
	baseUrl: string;
	apiKey?: string;
	/** pi 模型级协议（`model.api`）；缺省按 openai-completions 处理。 */
	api?: string;
}

export interface ProviderModelsResult {
	ok: boolean;
	/** 成功时上游返回的模型 id 清单（未去重，调用方按需处理）。 */
	ids: string[];
	httpStatus?: number;
	url?: string;
	error?: string;
	failureKind?: ProviderFailureKind;
}

/** 解析 `/models` 响应：openai 系与 anthropic 是 `{data:[{id}]}`、google 是
 * `{models:[{name:"models/xxx"}]}`，部分中转直接返回裸数组（三种都要兼容）。 */
function parseModelIds(body: string): string[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return [];
	}
	const list = Array.isArray(parsed)
		? parsed
		: typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { data?: unknown }).data)
			? (parsed as { data: unknown[] }).data
			: typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { models?: unknown }).models)
				? (parsed as { models: unknown[] }).models
				: [];
	return list
		.map((entry) => {
			if (typeof entry === "string") return entry;
			if (typeof entry !== "object" || entry === null) return "";
			const record = entry as Record<string, unknown>;
			if (typeof record.id === "string") return record.id;
			// google 的 `{name:"models/gemini-2.0-flash"}`：剥掉 `models/` 前缀。
			if (typeof record.name === "string") return record.name.replace(/^models\//, "");
			return "";
		})
		.filter((id) => id !== "");
}

/**
 * 拉取上游 `/models` 清单。三种协议的端点与鉴权头逐字复刻 pi（anthropic 用
 * `x-api-key` + `anthropic-version`、google 用 `x-goog-api-key`、其余走
 * `Authorization: Bearer`；key 一律走 header，不进 query 以免被日志记下）。
 *
 * 走网关而不是客户端直连：手机是**凭证盲**的，保存过的 provider 其 apiKey 只在
 * 宿主 models.json 里，编辑时表单是空的——直连必然 401（用户实测）。这里与
 * provider-test 同口径：表单值优先、缺省回退已存值。
 */
export async function fetchProviderModels(input: ProviderModelsInput): Promise<ProviderModelsResult> {
	if (!/^https?:\/\//.test(input.baseUrl)) {
		return { ok: false, ids: [], error: "Base URL 必须是 http(s) 地址" };
	}
	const api = input.api ?? "openai-completions";
	const key = input.apiKey ?? "";
	let url: string;
	let headers: Record<string, string>;
	try {
		if (api === "anthropic-messages") {
			// Anthropic 的 baseUrl 不含 /v1（SDK 自己拼段，与 testRequest 的
			// /v1/messages 同规矩），列模型端点是 /v1/models——漏这段会 404，正好
			// 复现「测试连接能过、拉取模型失败」（reviewer 抓到的 P1）。
			url = joinProviderUrl(input.baseUrl, "/v1/models?limit=100");
			headers = { "x-api-key": key, "anthropic-version": "2023-06-01" };
		} else if (api === "google-generative-ai") {
			url = joinProviderUrl(input.baseUrl, "/models");
			headers = { "x-goog-api-key": key };
		} else {
			url = joinProviderUrl(input.baseUrl, "/models");
			headers = { authorization: `Bearer ${key}` };
		}
	} catch {
		return { ok: false, ids: [], error: "Base URL 不是合法地址" };
	}
	try {
		const response = await fetch(url, {
			headers,
			// 与 provider-test 一致：不跟随重定向（中转常见 302 到登录页）。
			redirect: "manual",
			signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
		});
		const text = await readBodyCapped(response, MODELS_MAX_BODY_BYTES);
		const status = response.status;
		if (status >= 300 && status < 400) {
			return {
				ok: false,
				ids: [],
				failureKind: "config",
				httpStatus: status,
				url,
				error: `上游返回重定向（HTTP ${status}）→ ${response.headers.get("location") ?? "未知地址"}，请确认 baseUrl 是否少了路径段`,
			};
		}
		if (!response.ok) {
			const upstream = extractUpstreamMessage(text);
			const transient = status >= 500 || status === 429;
			const hint =
				status === 401 || status === 403
					? "认证失败，请检查 API Key"
					: status === 404
						? `端点不存在（${url}），${endpointHint(input.baseUrl, input.api)}`
						: transient
							? "上游暂时不可用（稍后重试即可，配置本身可能没问题）"
							: "上游返回错误";
			return {
				ok: false,
				ids: [],
				failureKind: transient ? "transient" : "config",
				httpStatus: status,
				url,
				error: `${hint}${upstream ? `：${upstream}` : `（HTTP ${status}）`}`,
			};
		}
		const ids = parseModelIds(text);
		if (ids.length === 0) {
			return {
				ok: false,
				ids: [],
				failureKind: "config",
				httpStatus: status,
				url,
				error: "上游返回里没有可解析的模型 id",
			};
		}
		return { ok: true, ids, httpStatus: status, url };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const timedOut = error instanceof Error && error.name === "TimeoutError";
		return {
			ok: false,
			ids: [],
			url,
			failureKind: "transient",
			error: timedOut ? "拉取超时（上游未在 12 秒内响应）" : `拉取失败：${message}`,
		};
	}
}

export interface ProviderStatus {
	ok: boolean;
	testedAt: string;
	error?: string;
	failureKind?: ProviderFailureKind;
}

/**
 * provider 测试状态的持久化（网关自己的文件，独立于 pi 的 models.json）。
 * 读取失败/文件缺失一律当“无记录”＝激活，绝不让状态文件把既有 provider 隐藏掉。
 */
export class ProviderStatusStore {
	private readonly path: string;
	private cache: Record<string, ProviderStatus> | undefined;

	constructor(path: string) {
		this.path = path;
	}

	read(): Record<string, ProviderStatus> {
		if (this.cache !== undefined) return this.cache;
		try {
			const parsed: unknown = JSON.parse(readFileSync(this.path, "utf8"));
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
				this.cache = {};
			} else {
				const result: Record<string, ProviderStatus> = {};
				for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
					if (typeof value !== "object" || value === null) continue;
					const entry = value as Record<string, unknown>;
					if (typeof entry.ok !== "boolean") continue;
					result[id] = {
						ok: entry.ok,
						testedAt: typeof entry.testedAt === "string" ? entry.testedAt : "",
						...(typeof entry.error === "string" ? { error: entry.error } : {}),
						...(entry.failureKind === "config" || entry.failureKind === "transient"
							? { failureKind: entry.failureKind }
							: {}),
					};
				}
				this.cache = result;
			}
		} catch (error) {
			// 文件缺失＝无记录（激活）。**读失败不缓存**：否则一次权限/IO 抖动后
			// 的 set() 会把盘上其他 provider 的记录整体覆盖掉。
			if ((error as NodeJS.ErrnoException)?.code === "ENOENT") this.cache = {};
			return {};
		}
		return this.cache;
	}

	/** 激活判定：只有**配置类**失败才未激活（灰显 + 模型不进菜单）。无记录、
	 *  读失败、临时类失败（超时/5xx/429）都视为激活——上游抖动不是配置问题。 */
	isActive(providerId: string): boolean {
		const status = this.read()[providerId];
		if (status === undefined) return true;
		if (status.ok) return true;
		return status.failureKind === "transient";
	}

	get(providerId: string): ProviderStatus | undefined {
		return this.read()[providerId];
	}

	set(providerId: string, status: ProviderStatus): void {
		const next = { ...this.read(), [providerId]: status };
		this.write(next);
		this.cache = next;
	}

	remove(providerId: string): void {
		const current = this.read();
		if (!(providerId in current)) return;
		const next = { ...current };
		delete next[providerId];
		this.write(next);
		this.cache = next;
	}

	private write(next: Record<string, ProviderStatus>): void {
		try {
			mkdirSync(dirname(this.path), { recursive: true });
			const temporaryPath = `${this.path}.tmp-${process.pid}-${Date.now()}`;
			writeFileSync(temporaryPath, `${JSON.stringify(next, null, "\t")}\n`, "utf8");
			renameSync(temporaryPath, this.path);
		} catch {
			// 状态写盘失败不影响本次测试结论的回传（下次测试会重写）。
		}
	}
}
