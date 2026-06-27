import { InteractiveMode, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

/**
 * tool-batch-summary
 * ------------------
 * Collapse a contiguous run of tool calls (read / ls / grep / find / bash /
 * edit / write / custom tools) into a single compact summary line, e.g.
 *
 *     Read 4 files
 *     Listed 1 directory
 *     Searched for 2 patterns
 *     Read 1 file, listed 2 directories, ran 2 shell commands
 *
 * While tools are in flight the summary stays expanded enough to show live
 * detail; once the contiguous batch finishes it collapses to one line.
 * Pressing the "expand tools" key (Ctrl+O / `app.tools.expand`) expands the
 * batch back to full per-tool output, exactly like an ordinary tool row.
 *
 * Pi exposes no public hook for transcript-level grouping, so this reaches
 * into pi internals the same way the bundled `claude-queue-escape` extension
 * does: it patches `InteractiveMode.prototype`. All patching is wrapped in
 * try/catch and guarded behind feature detection, so if pi's internals change
 * the extension quietly no-ops instead of breaking the UI.
 *
 * It also suppresses the redundant collapsed "Thinking..." placeholder that an
 * assistant turn renders when it only thinks + calls tools (no visible text)
 * and thinking display is hidden. Without this, every turn in a long tool loop
 * leaves a stray "Thinking..." line stacked around the batch summary. Set
 * SUPPRESS_EMPTY_THINKING = false to keep those placeholders.
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SUPPRESS_EMPTY_THINKING = true;

// In-flight preview: under the running summary line, show a dim, tree-connected
// preview of the current tool's call (the command / file path), capped at this
// many logical lines (each truncated to width — no wrapping, no layout shift).
const PREVIEW_MAX_LINES = 2;
const SUMMARY_INDENT = "  "; // matches the `  ${summary}` indent
const PREVIEW_CONNECTOR = "└─ "; // pi's own tree-branch glyph (tree/session selectors)
const PREVIEW_CONT_INDENT = "   "; // aligns wrapped/continuation lines under the content
const PREVIEW_PREFIX_WIDTH = SUMMARY_INDENT.length + PREVIEW_CONNECTOR.length; // 5 cols
// Render the pending tool this wide so long single lines stay one logical line
// (we truncate them) instead of being wrapped by the inner Text component.
const PREVIEW_RENDER_WIDTH = 4096;

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

// The live theme Proxy (captured from ctx.ui.theme). Always reflects the
// active theme, so a single capture is enough even across theme switches.
let THEME: any;

function fg(color: string, text: string): string {
	const t = THEME;
	return t && typeof t.fg === "function" ? t.fg(color, text) : text;
}

// ---------------------------------------------------------------------------
// Tool category / label model
// ---------------------------------------------------------------------------

type Label = { complete: string; pending: string; singular: string; plural: string };

const TOOL_LABELS: Record<string, Label> = {
	read: { complete: "read", pending: "reading", singular: "file", plural: "files" },
	ls: { complete: "listed", pending: "listing", singular: "directory", plural: "directories" },
	search: { complete: "searched for", pending: "searching for", singular: "pattern", plural: "patterns" },
	bash: { complete: "ran", pending: "running", singular: "shell command", plural: "shell commands" },
	edit: { complete: "edited", pending: "editing", singular: "file", plural: "files" },
	write: { complete: "wrote", pending: "writing", singular: "file", plural: "files" },
};

function getToolCategory(toolName: string): string {
	if (toolName === "grep" || toolName === "find") return "search";
	if (toolName in TOOL_LABELS) return toolName;
	return `tool:${toolName}`;
}

function getToolLabel(category: string): Label {
	if (category in TOOL_LABELS) return TOOL_LABELS[category];
	const toolName = category.startsWith("tool:") ? category.slice("tool:".length) : "tool";
	return {
		complete: "ran",
		pending: "running",
		singular: `${toolName} call`,
		plural: `${toolName} calls`,
	};
}

function isToolPending(component: any): boolean {
	return !component.result || component.isPartial;
}

function isToolError(component: any): boolean {
	return component.result?.isError === true;
}

function summarizeTools(tools: any[]): string {
	const groups = new Map<string, { mode: "pending" | "complete"; category: string; count: number }>();
	for (const tool of tools) {
		const mode = isToolPending(tool) ? "pending" : "complete";
		const category = getToolCategory(tool.toolName);
		const key = `${mode}:${category}`;
		const existing = groups.get(key);
		if (existing) existing.count++;
		else groups.set(key, { mode, category, count: 1 });
	}
	const parts: string[] = [];
	for (const group of groups.values()) {
		const label = getToolLabel(group.category);
		const verb = group.mode === "pending" ? label.pending : label.complete;
		const noun = group.count === 1 ? label.singular : label.plural;
		parts.push(`${verb} ${group.count} ${noun}`);
	}
	if (parts.length === 0) return "Running tools";
	const text = parts.join(", ");
	return text.charAt(0).toUpperCase() + text.slice(1);
}

// Strip the escape sequences pi-tui emits — SGR colour/background runs (CSI
// `...m` and other CSI codes) and OSC hyperlinks / prompt markers — so a line
// that is only background-padding spaces collapses to "".
function stripAnsi(s: string): string {
	return s
		.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
		.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
}

// Extract up to `max` logical content lines (the call header — command / file
// path) from a pending tool, as plain text. A pending ToolExecutionComponent
// renders as a padded Box: a Spacer blank line (""), then the Box's top padding
// line (spaces wrapped in a background bgFn — which is NOT "", so it survives a
// naive blank-line strip), then the real call header. We skip every line that
// is blank once ANSI is stripped and whitespace trimmed (this drops both the
// Spacer line and the bg-padding line — the old `[0]` cutoff bug), and keep the
// rest as the in-flight preview.
//
// The tool is rendered at a very wide width so a single long line (e.g. a long
// path) stays ONE logical line that we truncate ourselves, instead of being
// wrapped by the inner Text component into several fragments — the caller wants
// "max N lines of the command", not N wrap-fragments of one line.
function previewLines(tool: any, max: number): string[] {
	let rendered: unknown;
	try {
		rendered = tool.render(PREVIEW_RENDER_WIDTH);
	} catch {
		return [];
	}
	if (!Array.isArray(rendered)) return [];
	const out: string[] = [];
	for (const raw of rendered) {
		const plain = stripAnsi(String(raw)).replace(/\s+$/u, ""); // drop bg-padding tail
		if (plain.trim() === "") continue; // skip blank + bg-padding lines
		out.push(plain.replace(/^ /, "")); // drop the Box's single leftPad space
		if (out.length >= max) break;
	}
	return out;
}

// ---------------------------------------------------------------------------
// Summary component
// ---------------------------------------------------------------------------
//
// Implements just enough of pi's Component contract (render + invalidate) plus
// the extra methods pi calls on tool rows (setExpanded / setShowImages /
// setImageWidthCells). It is NOT a Container subclass: it keeps its tools in a
// private array and renders them itself, so collapsing is a pure render-time
// decision and nothing is removed from the chat container.

class ToolBatchSummaryComponent {
	tools: any[] = [];
	expanded = false;

	addTool(component: any): void {
		this.tools.push(component);
		component.setExpanded?.(this.expanded);
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		for (const tool of this.tools) tool.setExpanded?.(expanded);
	}

	setShowImages(show: boolean): void {
		for (const tool of this.tools) tool.setShowImages?.(show);
	}

	setImageWidthCells(width: number): void {
		for (const tool of this.tools) tool.setImageWidthCells?.(width);
	}

	invalidate(): void {
		for (const tool of this.tools) tool.invalidate?.();
	}

	render(width: number): string[] {
		if (this.tools.length === 0) return [];
		if (this.expanded) return this.tools.flatMap((tool) => tool.render(width));

		const pendingTools = this.tools.filter(isToolPending);
		const failedCount = this.tools.filter(isToolError).length;

		let summary = summarizeTools(this.tools);
		if (failedCount > 0 && pendingTools.length === 0) summary += ` (${failedCount} failed)`;
		if (pendingTools.length > 0) summary += "…";

		const summaryColor =
			failedCount > 0 && pendingTools.length === 0
				? "error"
				: pendingTools.length > 0
					? "toolTitle"
					: "muted";

		const lines = ["", truncateToWidth(fg(summaryColor, `${SUMMARY_INDENT}${summary}`), width, "…")];
		// While the batch is still running, show a dim, tree-connected preview of
		// the current tool's call (command / file path), capped at
		// PREVIEW_MAX_LINES. Only the first pending tool is previewed, and each
		// line is truncated (not wrapped), so the block height is bounded — no
		// layout shift when the model queues many calls at once.
		if (pendingTools.length > 0) {
			const preview = previewLines(pendingTools[0], PREVIEW_MAX_LINES);
			for (let i = 0; i < preview.length; i++) {
				const prefix = SUMMARY_INDENT + (i === 0 ? PREVIEW_CONNECTOR : PREVIEW_CONT_INDENT);
				const body = truncateToWidth(preview[i], Math.max(1, width - PREVIEW_PREFIX_WIDTH), "…");
				lines.push(truncateToWidth(fg("dim", prefix + body), width, "…"));
			}
		}
		return lines;
	}
}

// ---------------------------------------------------------------------------
// Component classification (by stable dist class names, with duck-typed fallback)
// ---------------------------------------------------------------------------

function isToolComponent(c: any): boolean {
	return c?.constructor?.name === "ToolExecutionComponent" || typeof c?.markExecutionStarted === "function";
}

function isAssistantComponent(c: any): boolean {
	return c?.constructor?.name === "AssistantMessageComponent";
}

function hasVisibleAssistantText(message: any): boolean {
	if (!message || !Array.isArray(message.content)) return false;
	return message.content.some(
		(c: any) => c?.type === "text" && typeof c.text === "string" && c.text.trim().length > 0,
	);
}

// ---------------------------------------------------------------------------
// chatContainer.addChild interception (the batching engine)
// ---------------------------------------------------------------------------

const SYM_ORIG = Symbol.for("levi.pi.tool-batch-summary.orig");
const SYM_STATE = Symbol.for("levi.pi.tool-batch-summary.state");
const SYM_ARENDER = Symbol.for("levi.pi.tool-batch-summary.assistant-render-wrapped");

type BatchState = { batch: ToolBatchSummaryComponent | undefined };

// Can the current batch absorb the next tool? Only if everything added to the
// chat after the batch is an assistant turn with no visible text (i.e. the
// streaming/finished assistant message that only thought + called tools).
function canReuseBatch(chat: any, state: BatchState): boolean {
	const batch = state.batch;
	if (!batch) return false;
	const children = chat.children;
	const idx = children.indexOf(batch);
	if (idx === -1) return false;
	for (let i = idx + 1; i < children.length; i++) {
		const child = children[i];
		if (isAssistantComponent(child) && !hasVisibleAssistantText(child.lastMessage)) continue;
		return false;
	}
	return true;
}

// Render-suppress an assistant component that would only show the collapsed
// "Thinking..." placeholder (thinking hidden, no visible text, tool-only turn).
function maybeWrapAssistantRender(comp: any): void {
	if (!SUPPRESS_EMPTY_THINKING) return;
	if (!comp || comp[SYM_ARENDER]) return;
	if (typeof comp.render !== "function") return;
	comp[SYM_ARENDER] = true;
	const origRender = comp.render.bind(comp);
	comp.render = (width: number): string[] => {
		if (comp.hideThinkingBlock && comp.hasToolCalls && !hasVisibleAssistantText(comp.lastMessage)) {
			return [];
		}
		return origRender(width);
	};
}

function routeAddChild(chat: any, mode: any, orig: any, state: BatchState, component: any): void {
	if (isToolComponent(component)) {
		if (!canReuseBatch(chat, state)) {
			const batch = new ToolBatchSummaryComponent();
			batch.setExpanded(!!mode.toolOutputExpanded);
			state.batch = batch;
			orig.addChild(batch);
		}
		state.batch!.addTool(component);
		return;
	}

	if (isAssistantComponent(component)) {
		maybeWrapAssistantRender(component);
		// An assistant turn with no visible text (only thinking + tool calls)
		// must NOT break the batch — its tools should keep grouping.
		if (!hasVisibleAssistantText(component.lastMessage)) {
			orig.addChild(component);
			return;
		}
	}

	// Anything else (visible assistant text, user messages, bash, summaries,
	// status/error/warning lines, spacers, …) ends the contiguous run.
	state.batch = undefined;
	orig.addChild(component);
}

function installOnChat(chat: any, mode: any): void {
	if (!chat[SYM_ORIG]) {
		chat[SYM_ORIG] = { addChild: chat.addChild.bind(chat), clear: chat.clear.bind(chat) };
	}
	if (!chat[SYM_STATE]) chat[SYM_STATE] = { batch: undefined } as BatchState;
	const orig = chat[SYM_ORIG];
	const state: BatchState = chat[SYM_STATE];

	// Re-bind from the stored true original each time, so reloads can't stack
	// wrappers and always pick up the latest code.
	chat.addChild = (component: any) => {
		try {
			routeAddChild(chat, mode, orig, state, component);
		} catch {
			orig.addChild(component);
		}
	};
	chat.clear = () => {
		state.batch = undefined;
		orig.clear();
	};
}

// Per-module-load record of which chat containers we've installed on. A fresh
// WeakSet on each reload guarantees exactly one (re)install per load.
const installedChats = new WeakSet<object>();

function ensureInstalled(mode: any): void {
	try {
		const chat = mode?.chatContainer;
		if (!chat || installedChats.has(chat)) return;
		installOnChat(chat, mode);
		installedChats.add(chat);
	} catch {
		/* feature-detection failure: leave pi untouched */
	}
}

// ---------------------------------------------------------------------------
// Prototype patching (installation trigger)
// ---------------------------------------------------------------------------
//
// We don't change any method body — we only prepend `ensureInstalled(this)` to
// a couple of methods that are guaranteed to run with a fully constructed
// `this.chatContainer` before any tool/assistant component is added:
//   - handleEvent          → every live agent event (covers fresh sessions)
//   - renderInitialMessages → startup + resume initial transcript render
// Idempotent across reloads via a Symbol.for ref-count, mirroring the bundled
// claude-queue-escape extension.

const PATCH_SYM = Symbol.for("levi.pi.tool-batch-summary.patched");
const HOOK_METHODS = ["handleEvent", "renderInitialMessages"] as const;

// Whether we managed to hook pi's internals on this load. Used to warn the
// user once if a future pi upgrade moves the internals this relies on.
let patchApplied = false;

function patchPrototype(): boolean {
	const proto: any = (InteractiveMode as any)?.prototype;
	if (!proto) return false;

	const existing = proto[PATCH_SYM];
	if (existing) {
		existing.refCount += 1;
		return true;
	}

	const originals: Record<string, any> = {};
	let hooked = 0;
	for (const name of HOOK_METHODS) {
		const orig = proto[name];
		if (typeof orig !== "function") continue;
		originals[name] = orig;
		proto[name] = function (this: any, ...args: any[]) {
			ensureInstalled(this);
			return orig.apply(this, args);
		};
		hooked++;
	}

	if (hooked === 0) return false; // pi internals changed: leave pi untouched
	proto[PATCH_SYM] = { originals, refCount: 1 };
	return true;
}

function unpatchPrototype(): void {
	const proto: any = (InteractiveMode as any)?.prototype;
	const state = proto?.[PATCH_SYM];
	if (!state) return;
	state.refCount -= 1;
	if (state.refCount > 0) return;
	for (const [name, fn] of Object.entries(state.originals)) {
		proto[name] = fn;
	}
	delete proto[PATCH_SYM];
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

let warnedAboutPatch = false;

export default function toolBatchSummary(pi: ExtensionAPI): void {
	try {
		patchApplied = patchPrototype();
	} catch {
		patchApplied = false; // never let a patch failure crash startup
	}

	pi.on("session_start", async (_event, ctx: ExtensionContext) => {
		try {
			const t = (ctx.ui as any)?.theme;
			if (t) THEME = t;
		} catch {
			/* theme stays at its previous (or undefined → identity) value */
		}
		// If pi's internals moved (e.g. after an upgrade) and we couldn't hook
		// them, say so once instead of silently doing nothing.
		if (!patchApplied && !warnedAboutPatch) {
			warnedAboutPatch = true;
			try {
				ctx.ui.notify(
					"tool-batch-summary: could not hook pi internals (pi may have changed) — tool batching is disabled.",
					"warning",
				);
			} catch {
				/* ignore */
			}
		}
	});

	pi.on("session_shutdown", async () => {
		try {
			unpatchPrototype();
		} catch {
			/* ignore */
		}
	});
}

// Internal hooks exposed only for the offline test harness. pi uses the
// default export, so this named export is inert at runtime.
export const __test__ = {
	installOnChat,
	summarizeTools,
	canReuseBatch,
	hasVisibleAssistantText,
	stripAnsi,
	previewLines,
	ToolBatchSummaryComponent,
	setTheme: (t: any) => {
		THEME = t;
	},
};
