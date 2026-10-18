// Provider 最小生成探针：按协议验证实际模型响应，不认证完整聊天能力。
// 测试不写模型配置；诊断只保留短文案与稳定码，避免上游错误泄露地址和凭据。

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** 失败类型：`config` = 可判定的配置问题（非法 URL、认证被拒、HTTP 端点不存在、网页响应等）；
 *  `transient` = 超时/5xx/429/网络失败，**不得因此禁用 provider**；DNS 失败本身不足以确定配置错误。
 *  实测教训：中转站响应从 2s 到 >12s 波动，把超时当配置错会让“配置正确”的
 *  provider 反复变灰（模型从选择器消失）。 */
export type ProviderFailureKind = "config" | "transient";

/** 单次测试的结论。`error` 是可直接展示给用户的中文说明。 */
export interface ProviderTestResult {
	/** 稳定诊断码；旧客户端可继续读取短 error。 */
	code?: string;
	ok: boolean;
	latencyMs: number;
	/** 上游 HTTP 状态码（网络层失败时缺省）。 */
	httpStatus?: number;
	/** 旧响应的兼容字段；当前探针不回显地址。 */
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
			body: { contents: [{ parts: [{ text: "ping" }] }], generationConfig: { maxOutputTokens: TEST_MAX_TOKENS } },
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
	// 调用方已校验协议；这里只处理 openai-completions。
	return {
		url: joinProviderUrl(input.baseUrl, "/chat/completions"),
		headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
		body: { model: input.modelId, max_tokens: TEST_MAX_TOKENS, messages: [{ role: "user", content: "ping" }] },
	};
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

const TEST_ERRORS: Record<string, string> = {
	"invalid-url": "地址格式不正确",
	"missing-model": "请填写模型 ID",
	"unsupported-api": "当前协议不支持连接测试",
	"auth-rejected": "认证被拒",
	"access-denied": "请求被拒",
	"not-found": "接口或模型不存在",
	"payment-required": "上游要求付费",
	"rate-limited": "请求受限",
	"upstream-error": "上游服务异常",
	"request-rejected": "上游拒绝请求",
	"model-unavailable": "模型不存在或无访问权限",
	"insufficient-quota": "上游额度不足",
	redirect: "地址发生重定向",
	"html-response": "地址返回了网页",
	"invalid-response": "未收到有效模型响应",
	timeout: "请求超时",
	"dns-failed": "无法解析服务地址",
	"tls-failed": "安全连接失败",
	"connection-refused": "服务拒绝连接",
	"network-error": "网络连接失败",
};

function object(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function hasText(value: unknown): boolean {
	return typeof value === "string" && value.trim().length > 0;
}

/** 只认各协议的模型输出形态；不能用“有 JSON”代替实际模型应答。 */
function hasModelResponse(body: unknown, api: string): boolean {
	const value = object(body);
	if (!value) return false;
	if (api === "anthropic-messages") {
		return (
			value.type === "message" &&
			Array.isArray(value.content) &&
			value.content.some((part: unknown) => {
				const item = object(part);
				return (item?.type === "text" && hasText(item.text)) || (item?.type === "thinking" && hasText(item.thinking));
			})
		);
	}
	if (api === "google-generative-ai") {
		return (
			Array.isArray(value.candidates) &&
			value.candidates.some((candidate: unknown) => {
				const parts = object(object(candidate)?.content)?.parts;
				return Array.isArray(parts) && parts.some((part: unknown) => hasText(object(part)?.text));
			})
		);
	}
	if (api === "openai-responses") {
		return (
			value.status !== "failed" &&
			Array.isArray(value.output) &&
			value.output.some((part: unknown) => {
				const item = object(part);
				const content = item?.type === "message" ? item.content : item?.type === "reasoning" ? item.summary : undefined;
				return Array.isArray(content) && content.some((chunk: unknown) => hasText(object(chunk)?.text));
			})
		);
	}
	return (
		Array.isArray(value.choices) &&
		value.choices.some((choice: unknown) => {
			const message = object(object(choice)?.message);
			return hasText(message?.content) || hasText(message?.reasoning_content) || hasText(message?.reasoning);
		})
	);
}

function httpFailureCode(status: number, body: unknown): string {
	if (status === 401) return "auth-rejected";
	if (status === 403) return "access-denied";
	const error = object(object(body)?.error);
	const upstreamCode = error?.code ?? error?.type;
	// 只采用确定的结构化错误码；不将上游 message 或任意字符串回显。
	if (upstreamCode === "model_not_found") return "model-unavailable";
	if (upstreamCode === "insufficient_quota") return "insufficient-quota";
	if (status === 404) return "not-found";
	if (status === 402) return "payment-required";
	if (status === 429) return "rate-limited";
	if (status >= 500) return "upstream-error";
	return "request-rejected";
}

function networkFailureCode(error: unknown): string {
	const item = object(error);
	const cause = object(item?.cause);
	const code = item?.code ?? cause?.code;
	if (
		item?.name === "TimeoutError" ||
		item?.name === "AbortError" ||
		code === "ETIMEDOUT" ||
		code === "UND_ERR_CONNECT_TIMEOUT"
	)
		return "timeout";
	if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "dns-failed";
	if (code === "ECONNREFUSED") return "connection-refused";
	if (typeof code === "string" && /CERT|^ERR_TLS|^DEPTH_ZERO|^UNABLE_TO_VERIFY/.test(code)) return "tls-failed";
	return "network-error";
}

export async function testProvider(input: ProviderTestInput): Promise<ProviderTestResult> {
	const startedAt = Date.now();
	const failure = (code: string, httpStatus?: number, transient = false): ProviderTestResult => ({
		ok: false,
		code,
		error: TEST_ERRORS[code],
		latencyMs: Date.now() - startedAt,
		...(httpStatus === undefined ? {} : { httpStatus }),
		failureKind: transient ? "transient" : "config",
	});
	if (!/^https?:\/\//.test(input.baseUrl)) return failure("invalid-url");
	if (!input.modelId.trim()) return failure("missing-model");
	const api = input.api ?? "openai-completions";
	if (!["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"].includes(api))
		return failure("unsupported-api");
	let request: ReturnType<typeof testRequest>;
	try {
		request = testRequest(input);
	} catch {
		return failure("invalid-url");
	}
	const signal = AbortSignal.timeout(TEST_TIMEOUT_MS);
	try {
		const response = await fetch(request.url, {
			method: "POST",
			headers: request.headers,
			body: JSON.stringify(request.body),
			redirect: "manual",
			signal,
		});
		const status = response.status;
		if (status >= 300 && status < 400) {
			await response.body?.cancel();
			return failure("redirect", status);
		}
		const text = await readBodyCapped(response, MAX_BODY_BYTES);
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			parsed = undefined;
		}
		if (!response.ok) return failure(httpFailureCode(status, parsed), status, status === 429 || status >= 500);
		if (object(parsed)?.error != null) return failure(httpFailureCode(status, parsed), status);
		if (/^\s*<(!doctype|html|\?xml)/i.test(text)) return failure("html-response", status);
		if (!hasModelResponse(parsed, api)) return failure("invalid-response", status);
		return { ok: true, latencyMs: Date.now() - startedAt, httpStatus: status };
	} catch (error) {
		return failure(signal.aborted ? "timeout" : networkFailureCode(error), undefined, true);
	}
}

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
