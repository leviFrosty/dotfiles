import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

type ContentBlock = {
	type?: string;
	text?: string;
	name?: string;
	arguments?: Record<string, unknown>;
};

type SessionEntry = {
	type: string;
	summary?: string;
	customType?: string;
	content?: unknown;
	message?: {
		role?: string;
		content?: unknown;
		toolName?: string;
		details?: unknown;
		usage?: {
			input?: number;
			output?: number;
			cacheRead?: number;
			cacheWrite?: number;
			cost?: { total?: number };
		};
	};
};

type RecapMode = "manual" | "auto";
type RecapContext = ExtensionContext | ExtensionCommandContext;
type RecapResult = { ok: true; recap: string } | { ok: false; error: string };

const DEFAULT_IDLE_MS = 3 * 60 * 1000;
const MAX_CONVERSATION_CHARS = 80_000;
const MAX_RECAP_CHARS = 180;
const RECAP_STATUS_KEY = "zz-recap";

const getIdleMs = () => {
	const raw = process.env.PI_RECAP_IDLE_MS;
	if (!raw) return DEFAULT_IDLE_MS;
	const parsed = Number(raw);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_IDLE_MS;
};

const extractTextParts = (content: unknown): string[] => {
	if (typeof content === "string") return [content];
	if (!Array.isArray(content)) return [];

	const textParts: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const block = part as ContentBlock;
		if (block.type === "text" && typeof block.text === "string") {
			textParts.push(block.text);
		}
	}
	return textParts;
};

const extractToolCallLines = (content: unknown): string[] => {
	if (!Array.isArray(content)) return [];

	const toolCalls: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const block = part as ContentBlock;
		if (block.type !== "toolCall" || typeof block.name !== "string") continue;
		toolCalls.push(`Tool call: ${block.name} ${JSON.stringify(block.arguments ?? {})}`);
	}
	return toolCalls;
};

const truncateBlock = (text: string, maxChars: number) => {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}… [truncated ${text.length - maxChars} chars]`;
};

const capConversation = (text: string) => {
	if (text.length <= MAX_CONVERSATION_CHARS) return text;
	const headChars = 20_000;
	const tailChars = MAX_CONVERSATION_CHARS - headChars;
	const omitted = text.length - headChars - tailChars;
	return [
		text.slice(0, headChars),
		`\n\n[... ${omitted} characters omitted from the middle; recent context follows ...]\n\n`,
		text.slice(-tailChars),
	].join("");
};

const buildConversationText = (entries: SessionEntry[]): string => {
	const sections: string[] = [];

	for (const entry of entries) {
		if (entry.type === "compaction" && entry.summary) {
			sections.push(`Existing compaction summary:\n${entry.summary}`);
			continue;
		}

		if (entry.type === "branch_summary" && entry.summary) {
			sections.push(`Existing branch summary:\n${entry.summary}`);
			continue;
		}

		if (entry.type === "custom_message" && entry.customType !== "recap" && entry.content) {
			const text = extractTextParts(entry.content).join("\n").trim();
			if (text) sections.push(`Context message (${entry.customType ?? "custom"}):\n${truncateBlock(text, 2000)}`);
			continue;
		}

		if (entry.type !== "message" || !entry.message?.role) continue;

		const role = entry.message.role;
		const entryLines: string[] = [];
		const textParts = extractTextParts(entry.message.content);
		const messageText = textParts.join("\n").trim();

		if (messageText) {
			const label = role === "toolResult" ? `Tool result${entry.message.toolName ? ` (${entry.message.toolName})` : ""}` : role[0].toUpperCase() + role.slice(1);
			entryLines.push(`${label}: ${truncateBlock(messageText, role === "toolResult" ? 1500 : 4000)}`);
		}

		if (role === "assistant") {
			entryLines.push(...extractToolCallLines(entry.message.content));
		}

		if (entryLines.length > 0) sections.push(entryLines.join("\n"));
	}

	return capConversation(sections.join("\n\n"));
};

const buildRecapPrompt = (conversationText: string, mode: RecapMode) =>
	[
		"Create a tiny one-line briefing for this active coding-agent conversation.",
		"Maximum 34 words. One sentence only. No Markdown headings, bullets, labels, or prefix.",
		"Mention the goal, completed state, and next action if known. Include key PR/branch/file names only if important.",
		"Do not invent details. If something is unknown, omit it.",
		mode === "auto" ? "This recap will be shown as the final bottom footer line after the user returns from idle time." : "This recap will be shown as the final bottom footer line now.",
		"",
		"Good style: Goal was speeding up Contacts first paint, now done and committed; PR #370 is open; next decide whether mytime work needs its own branch.",
		"",
		"<conversation>",
		conversationText,
		"</conversation>",
	].join("\n");

const cleanRecap = (text: string) => {
	const withoutPrefix = text
		.replace(/^\s*#+\s*recap\s*/i, "")
		.replace(/^\s*[※*\-•>\s]*(?:recap|summary)\s*:\s*/i, "")
		.replace(/\s+/g, " ")
		.trim();

	const words = withoutPrefix.split(/\s+/).filter(Boolean);
	return words.length <= 34 ? withoutPrefix : `${words.slice(0, 34).join(" ")}…`;
};

const truncateRecapForFooter = (recap: string) => {
	if (recap.length <= MAX_RECAP_CHARS) return recap;
	return `${recap.slice(0, MAX_RECAP_CHARS - 1)}…`;
};

const createRecap = async (ctx: RecapContext, mode: RecapMode): Promise<RecapResult> => {
	const branch = ctx.sessionManager.getBranch() as SessionEntry[];
	const conversationText = buildConversationText(branch);
	if (!conversationText.trim()) return { ok: false, error: "No conversation text found" };

	const model = ctx.model;
	if (!model) return { ok: false, error: "No active model found" };

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) return { ok: false, error: auth.error };
	if (!auth.apiKey) return { ok: false, error: `No API key for ${model.provider}/${model.id}` };

	const response = await completeSimple(
		model,
		{
			messages: [
				{
					role: "user" as const,
					content: [{ type: "text" as const, text: buildRecapPrompt(conversationText, mode) }],
					timestamp: Date.now(),
				},
			],
		},
		{
			apiKey: auth.apiKey,
			headers: auth.headers,
			maxTokens: 160,
			reasoning: model.reasoning ? "minimal" : undefined,
			signal: ctx.signal,
		},
	);

	if (response.stopReason === "error") {
		return { ok: false, error: response.errorMessage || "Recap request failed" };
	}

	const recap = cleanRecap(
		response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n"),
	);

	return recap ? { ok: true, recap } : { ok: false, error: `Model returned no recap text (stop: ${response.stopReason})` };
};

export default function (pi: ExtensionAPI) {
	let lastSurfaceTouchAt = Date.now();
	let lastAutoRecapLeafId: string | undefined;
	let recapInFlight = false;
	let activeCtx: RecapContext | undefined;
	let unsubscribeTerminalInput: (() => void) | undefined;
	let runId = 0;

	const setRecapFooterLine = (ctx: RecapContext, text: string | undefined) => {
		ctx.ui.setStatus(RECAP_STATUS_KEY, text);
	};

	const markSurfaceTouched = () => {
		lastSurfaceTouchAt = Date.now();
	};

	const shouldTriggerAfterIdle = () => {
		const idleMs = getIdleMs();
		return idleMs > 0 && Date.now() - lastSurfaceTouchAt >= idleMs;
	};

	const startRecap = (ctx: RecapContext, mode: RecapMode) => {
		if (recapInFlight) return;

		const leafId = ctx.sessionManager.getLeafId();
		if (mode === "auto" && (!leafId || leafId === lastAutoRecapLeafId)) return;
		if (mode === "auto") lastAutoRecapLeafId = leafId;

		const currentRunId = ++runId;
		recapInFlight = true;
		setRecapFooterLine(ctx, "※ recap…");

		void createRecap(ctx, mode)
			.then((result) => {
				if (currentRunId !== runId) return;
				if (!result.ok) {
					setRecapFooterLine(ctx, undefined);
					if (mode === "manual" && ctx.hasUI) ctx.ui.notify(result.error, "warning");
					return;
				}
				setRecapFooterLine(ctx, `※ ${truncateRecapForFooter(result.recap)}`);
			})
			.catch((error: unknown) => {
				if (currentRunId !== runId) return;
				const message = error instanceof Error ? error.message : String(error);
				setRecapFooterLine(ctx, undefined);
				if (mode === "manual" && ctx.hasUI) ctx.ui.notify(message, "warning");
			})
			.finally(() => {
				if (currentRunId === runId) recapInFlight = false;
			});
	};

	const maybeStartAutoRecapOnReturn = (ctx: RecapContext) => {
		activeCtx = ctx;
		if (!shouldTriggerAfterIdle()) return;
		startRecap(ctx, "auto");
	};

	pi.registerCommand("recap", {
		description: "Show a tiny one-line recap of the current conversation below the footer",
		handler: async (_args, ctx) => {
			activeCtx = ctx;
			await ctx.waitForIdle();
			startRecap(ctx, "manual");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		activeCtx = ctx;
		lastSurfaceTouchAt = Date.now();
		lastAutoRecapLeafId = undefined;
		recapInFlight = false;
		runId++;
		setRecapFooterLine(ctx, undefined);

		unsubscribeTerminalInput?.();
		unsubscribeTerminalInput = undefined;
		if (ctx.mode === "tui") {
			unsubscribeTerminalInput = ctx.ui.onTerminalInput(() => {
				const ctxForReturn = activeCtx;
				const returnedAfterTtl = shouldTriggerAfterIdle();
				markSurfaceTouched();
				if (returnedAfterTtl && ctxForReturn) startRecap(ctxForReturn, "auto");
				return undefined;
			});
		}
	});

	pi.on("resources_discover", async (_event, ctx) => {
		activeCtx = ctx;
	});

	pi.on("model_select", async (_event, ctx) => {
		activeCtx = ctx;
	});

	pi.on("agent_end", async (_event, ctx) => {
		activeCtx = ctx;
		if (ctx.mode !== "tui") markSurfaceTouched();
	});

	pi.on("input", async (event, ctx) => {
		activeCtx = ctx;
		if (event.source === "extension" || event.streamingBehavior) return { action: "continue" as const };
		if (event.text.trim() === "/recap") return { action: "continue" as const };

		maybeStartAutoRecapOnReturn(ctx);
		markSurfaceTouched();
		return { action: "continue" as const };
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		runId++;
		recapInFlight = false;
		lastAutoRecapLeafId = undefined;
		activeCtx = undefined;
		setRecapFooterLine(ctx, undefined);
		unsubscribeTerminalInput?.();
		unsubscribeTerminalInput = undefined;
	});
}
