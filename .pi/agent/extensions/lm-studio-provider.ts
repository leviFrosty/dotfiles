import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROVIDER_ID = "lm-studio";
const PROVIDER_NAME = "LM Studio";
const DEFAULT_ROOT_URL = "http://localhost:1234";
const FETCH_TIMEOUT_MS = 2_500;

type LmStudioModel = {
	type?: string;
	publisher?: string;
	key?: string;
	display_name?: string;
	architecture?: string | null;
	quantization?: {
		name?: string | null;
		bits_per_weight?: number | null;
	} | null;
	params_string?: string | null;
	loaded_instances?: Array<{
		id?: string;
		config?: {
			context_length?: number;
		};
	}>;
	max_context_length?: number;
	capabilities?: {
		vision?: boolean;
		trained_for_tool_use?: boolean;
		reasoning?: {
			allowed_options?: string[];
			default?: string;
		} | null;
	} | null;
};

type LmStudioListResponse = {
	models?: LmStudioModel[];
};

type ProviderModel = {
	id: string;
	name: string;
	reasoning: boolean;
	thinkingLevelMap?: {
		minimal?: null;
		low?: null;
		medium?: null;
		high?: string | null;
		xhigh?: null;
	};
	input: Array<"text" | "image">;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
	compat: {
		supportsStore: false;
		supportsDeveloperRole: false;
		supportsReasoningEffort: false;
		supportsUsageInStreaming: false;
		maxTokensField: "max_tokens";
		supportsStrictMode: false;
	};
};

type RefreshResult =
	| { ok: true; count: number; restBaseUrl: string; chatBaseUrl: string; models: ProviderModel[] }
	| { ok: false; error: string; restBaseUrl: string; chatBaseUrl: string };

const LOCAL_OPENAI_COMPAT = {
	supportsStore: false,
	supportsDeveloperRole: false,
	supportsReasoningEffort: false,
	supportsUsageInStreaming: false,
	maxTokensField: "max_tokens",
	supportsStrictMode: false,
} as const;

function withoutTrailingSlash(value: string): string {
	return value.replace(/\/+$/, "");
}

function configuredRootUrl(): string {
	return withoutTrailingSlash(
		process.env.LM_STUDIO_BASE_URL ||
			process.env.LMSTUDIO_BASE_URL ||
			process.env.LM_STUDIO_URL ||
			process.env.LMSTUDIO_URL ||
			DEFAULT_ROOT_URL,
	);
}

function getBaseUrls() {
	const explicitRest = process.env.LM_STUDIO_REST_BASE_URL || process.env.LMSTUDIO_REST_BASE_URL;
	const explicitOpenAi = process.env.LM_STUDIO_OPENAI_BASE_URL || process.env.LMSTUDIO_OPENAI_BASE_URL;
	const root = configuredRootUrl();

	const rootWithoutKnownSuffix = root.replace(/\/api\/v1$/i, "").replace(/\/v1$/i, "");

	return {
		restBaseUrl: withoutTrailingSlash(explicitRest || `${rootWithoutKnownSuffix}/api/v1`),
		chatBaseUrl: withoutTrailingSlash(explicitOpenAi || `${rootWithoutKnownSuffix}/v1`),
	};
}

function configuredApiToken(): string | undefined {
	return (
		process.env.LM_API_TOKEN ||
		process.env.LM_STUDIO_API_KEY ||
		process.env.LMSTUDIO_API_KEY ||
		process.env.LM_STUDIO_API_TOKEN ||
		process.env.LMSTUDIO_API_TOKEN
	);
}

function providerApiKeyConfig(): string {
	if (process.env.LM_API_TOKEN) return "$LM_API_TOKEN";
	if (process.env.LM_STUDIO_API_KEY) return "$LM_STUDIO_API_KEY";
	if (process.env.LMSTUDIO_API_KEY) return "$LMSTUDIO_API_KEY";
	if (process.env.LM_STUDIO_API_TOKEN) return "$LM_STUDIO_API_TOKEN";
	if (process.env.LMSTUDIO_API_TOKEN) return "$LMSTUDIO_API_TOKEN";

	// LM Studio's OpenAI-compatible examples use a placeholder API key when
	// server auth is off. Pi still needs an auth value before listing/selecting
	// custom-provider models, so keep the same dummy-key convention.
	return "lm-studio";
}

async function fetchJsonWithTimeout(url: string, token?: string): Promise<unknown> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

	try {
		const headers: Record<string, string> = {};
		if (token) headers.Authorization = `Bearer ${token}`;

		const response = await fetch(url, { headers, signal: controller.signal });
		if (!response.ok) {
			const body = await response.text().catch(() => "");
			throw new Error(`${response.status} ${response.statusText}${body ? `: ${body.slice(0, 500)}` : ""}`);
		}

		return await response.json();
	} finally {
		clearTimeout(timeout);
	}
}

function contextWindowFor(model: LmStudioModel): number | undefined {
	const loadedContext = model.loaded_instances
		?.map((instance) => instance.config?.context_length)
		.find((value): value is number => typeof value === "number" && value > 0);

	return loadedContext ?? model.max_context_length;
}

function supportsReasoning(model: LmStudioModel): boolean {
	const reasoning = model.capabilities?.reasoning;
	if (!reasoning) return false;

	if (Array.isArray(reasoning.allowed_options)) {
		return reasoning.allowed_options.some((option) => option === "on" || option === "auto");
	}

	return typeof reasoning.default === "string" && reasoning.default !== "off";
}

function displayNameFor(model: LmStudioModel): string {
	const base = model.display_name || model.key || "LM Studio model";
	const suffixParts = [model.params_string, model.quantization?.name].filter(
		(part): part is string => typeof part === "string" && part.length > 0,
	);

	return suffixParts.length > 0 ? `${base} (${suffixParts.join(", ")})` : base;
}

function mapModels(payload: unknown): ProviderModel[] {
	const list = (payload as LmStudioListResponse).models;
	if (!Array.isArray(list)) {
		throw new Error("Unexpected LM Studio model-list response: missing models[]");
	}

	const byId = new Map<string, ProviderModel>();
	for (const model of list) {
		if (model.type !== "llm" || !model.key) continue;

		if (!(model.loaded_instances?.length ?? 0) > 0) continue;

		const contextWindow = contextWindowFor(model);
		if (!contextWindow) continue;

		const reasoning = supportsReasoning(model);
		byId.set(model.key, {
			id: model.key,
			name: displayNameFor(model),
			reasoning,
			thinkingLevelMap: reasoning
				? { minimal: null, low: null, medium: null, high: "on", xhigh: null }
				: undefined,
			input: model.capabilities?.vision ? ["text", "image"] : ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow,
			// LM Studio's list endpoint exposes context length but no separate output-token cap.
			// Use the model-derived context length as the largest safe output cap instead of inventing one.
			maxTokens: contextWindow,
			compat: LOCAL_OPENAI_COMPAT,
		});
	}

	return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function fetchLmStudioModels(): Promise<RefreshResult> {
	const { restBaseUrl, chatBaseUrl } = getBaseUrls();
	try {
		const payload = await fetchJsonWithTimeout(`${restBaseUrl}/models`, configuredApiToken());
		const models = mapModels(payload);
		return { ok: true, count: models.length, restBaseUrl, chatBaseUrl, models };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, error: message, restBaseUrl, chatBaseUrl };
	}
}

function registerLmStudioProvider(pi: ExtensionAPI, chatBaseUrl: string, models: ProviderModel[]) {
	pi.registerProvider(PROVIDER_ID, {
		name: PROVIDER_NAME,
		baseUrl: chatBaseUrl,
		apiKey: providerApiKeyConfig(),
		api: "openai-completions",
		models,
	});
}

export default async function (pi: ExtensionAPI) {
	let lastRefresh = await fetchLmStudioModels();
	if (lastRefresh.ok && lastRefresh.count > 0) {
		registerLmStudioProvider(pi, lastRefresh.chatBaseUrl, lastRefresh.models);
	}

	pi.registerCommand("lm-studio-refresh", {
		description: "Refresh LM Studio provider models from /api/v1/models",
		handler: async (_args, ctx) => {
			const refresh = await fetchLmStudioModels();
			lastRefresh = refresh;
			if (refresh.ok === false) {
				ctx.ui.notify(`LM Studio refresh failed: ${refresh.error}`, "error");
				return;
			}

			if (refresh.count === 0) {
				pi.unregisterProvider(PROVIDER_ID);
				ctx.ui.notify("LM Studio provider refreshed: no LLM models found", "warning");
				return;
			}

			registerLmStudioProvider(pi, refresh.chatBaseUrl, refresh.models);
			ctx.ui.notify(`LM Studio provider refreshed: ${refresh.count} model(s)`, "info");
		},
	});

	pi.registerCommand("lm-studio-status", {
		description: "Show LM Studio provider discovery status",
		handler: async (_args, ctx) => {
			const refresh = lastRefresh;
			if (refresh.ok === true) {
				ctx.ui.notify(
					`LM Studio: ${refresh.count} model(s) from ${refresh.restBaseUrl}; chat base ${refresh.chatBaseUrl}`,
					"info",
				);
				return;
			}

			ctx.ui.notify(`LM Studio unavailable at ${refresh.restBaseUrl}: ${refresh.error}`, "warning");
		},
	});
}
