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

// Completed edit previews: show the edit tool's compact display diff below the
// collapsed batch so successful code changes remain visible without expanding
// every read/bash/node_modules-inspection tool in the run.
const DIFF_MAX_LINES = 120;
const DIFF_INDENT = "     ";

// Skill reads are real read tool calls, but they deserve an explicit durable
// transcript marker instead of disappearing into "read N files". Render each
// detected skill read as its own line under the batch summary.
const SKILL_LINE_PREFIX = SUMMARY_INDENT + PREVIEW_CONNECTOR;

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

function latestToolFailed(tools: any[]): boolean {
	for (let i = tools.length - 1; i >= 0; i--) {
		const tool = tools[i];
		if (isToolPending(tool)) continue;
		return isToolError(tool);
	}
	return false;
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

function stringArg(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function firstStringArg(args: any, keys: string[]): string | undefined {
	for (const key of keys) {
		const value = stringArg(args?.[key]);
		if (value) return value;
	}
	return undefined;
}

function semanticPreviewLines(tool: any, max: number): string[] {
	const args = tool?.args;
	let text: string | undefined;
	switch (tool?.toolName) {
		case "bash":
			text = firstStringArg(args, ["command"]);
			break;
		case "read":
		case "edit":
		case "write":
		case "ls":
			text = firstStringArg(args, ["path", "file_path", "dir", "directory"]);
			break;
		case "grep": {
			const pattern = firstStringArg(args, ["pattern", "query"]);
			const path = firstStringArg(args, ["path", "include"]);
			text = [pattern, path].filter(Boolean).join(" — ") || undefined;
			break;
		}
		case "find":
			text = firstStringArg(args, ["path", "pattern", "name"]);
			break;
	}
	if (!text) return previewLines(tool, max);
	return text
		.split("\n")
		.map((line) => line.trimEnd())
		.filter((line) => line.trim().length > 0)
		.slice(0, max);
}

type EditDiffPreview = { path: string | undefined; diff: string };

function collectEditDiffs(tools: any[]): EditDiffPreview[] {
	const diffs: EditDiffPreview[] = [];
	for (const tool of tools) {
		if (tool?.toolName !== "edit" || isToolPending(tool) || isToolError(tool)) continue;
		const diff = tool.result?.details?.diff;
		if (typeof diff !== "string" || diff.trim().length === 0) continue;
		diffs.push({ path: firstStringArg(tool.args, ["path", "file_path"]), diff });
	}
	return diffs;
}

function renderDiffLine(line: string): string {
	const normalized = line.replace(/\t/g, "   ");
	if (normalized.startsWith("+")) return fg("toolDiffAdded", normalized);
	if (normalized.startsWith("-")) return fg("toolDiffRemoved", normalized);
	return fg("toolDiffContext", normalized);
}

function appendEditDiffLines(lines: string[], diffs: EditDiffPreview[], width: number): void {
	let remaining = DIFF_MAX_LINES;
	let omitted = 0;
	for (const diff of diffs) {
		if (remaining <= 0) {
			omitted += diff.diff.split("\n").filter((line) => line.length > 0).length + (diff.path ? 1 : 0);
			continue;
		}
		if (diff.path) {
			lines.push(truncateToWidth(fg("dim", `${SUMMARY_INDENT}${PREVIEW_CONNECTOR}${diff.path}`), width, "…"));
			remaining--;
		}
		for (const raw of diff.diff.split("\n")) {
			if (raw.length === 0) continue;
			if (remaining <= 0) {
				omitted++;
				continue;
			}
			lines.push(truncateToWidth(`${DIFF_INDENT}${renderDiffLine(raw)}`, width, "…"));
			remaining--;
		}
	}
	if (omitted > 0) {
		lines.push(truncateToWidth(fg("muted", `${DIFF_INDENT}… (${omitted} more diff lines)`), width, "…"));
	}
}

type SkillInvocationPreview = { name: string; state: "pending" | "complete" | "error"; path: string | undefined };

function normalizeSkillName(raw: string | undefined): string | undefined {
	const cleaned = raw?.trim().replace(/^['"]|['"]$/g, "");
	return cleaned && cleaned.length > 0 ? cleaned : undefined;
}

function normalizeToolPath(value: string | undefined): string | undefined {
	const normalized = value?.replace(/^@/, "").replace(/\\/g, "/").replace(/\/+$/u, "").trim();
	return normalized && normalized.length > 0 ? normalized : undefined;
}

function fileStem(fileName: string): string {
	return fileName.replace(/\.[^.]*$/u, "");
}

function skillNameFromPath(pathValue: string | undefined): string | undefined {
	const normalized = normalizeToolPath(pathValue);
	if (!normalized) return undefined;
	const parts = normalized.split("/").filter((part) => part.length > 0);
	const last = parts[parts.length - 1];
	if (!last) return undefined;

	if (last.toLowerCase() === "skill.md" && parts.length >= 2) {
		return normalizeSkillName(parts[parts.length - 2]);
	}

	// Pi also supports single-file skills in */skills/name.md.
	if (/\.md$/iu.test(last) && parts.includes("skills")) {
		return normalizeSkillName(fileStem(last));
	}

	return undefined;
}

function textFromToolResult(tool: any): string | undefined {
	const content = tool?.result?.content;
	if (!Array.isArray(content)) return undefined;
	const text = content
		.map((block: any) => (block?.type === "text" && typeof block.text === "string" ? block.text : ""))
		.filter((part: string) => part.length > 0)
		.join("\n");
	return text.length > 0 ? text : undefined;
}

function skillNameFromMarkdown(content: string | undefined): string | undefined {
	if (!content) return undefined;
	const head = content.slice(0, 4096);
	const frontmatter = head.match(/^\s*---\s*\n([\s\S]*?)\n---/u)?.[1] ?? head.split("\n").slice(0, 40).join("\n");
	const match = frontmatter.match(/^\s*name\s*:\s*([^\n#]+?)\s*$/imu);
	return normalizeSkillName(match?.[1]);
}

function skillInvocationForTool(tool: any): SkillInvocationPreview | undefined {
	if (tool?.toolName !== "read") return undefined;
	const path = firstStringArg(tool.args, ["path", "file_path"]);
	const pathName = skillNameFromPath(path);
	if (!pathName) return undefined;

	const resultName = !isToolPending(tool) && !isToolError(tool) ? skillNameFromMarkdown(textFromToolResult(tool)) : undefined;
	return {
		name: resultName ?? pathName,
		state: isToolPending(tool) ? "pending" : isToolError(tool) ? "error" : "complete",
		path: normalizeToolPath(path),
	};
}

function collectSkillInvocations(tools: any[]): SkillInvocationPreview[] {
	return tools.map(skillInvocationForTool).filter((skill): skill is SkillInvocationPreview => skill !== undefined);
}

function appendSkillInvocationLines(lines: string[], skills: SkillInvocationPreview[], width: number): void {
	for (const skill of skills) {
		const label = skill.state === "pending" ? "Using skill" : skill.state === "error" ? "Skill failed" : "Used skill";
		const color = skill.state === "pending" ? "toolTitle" : skill.state === "error" ? "error" : "accent";
		lines.push(truncateToWidth(fg(color, `${SKILL_LINE_PREFIX}${label}: ${skill.name}`), width, "…"));
	}
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
		const skillInvocations = collectSkillInvocations(this.tools);
		const editDiffs = pendingTools.length === 0 ? collectEditDiffs(this.tools) : [];

		let summary = summarizeTools(this.tools);
		if (failedCount > 0 && pendingTools.length === 0) summary += ` (${failedCount} failed)`;
		if (editDiffs.length > 0) summary += ":";
		if (pendingTools.length > 0) summary += "…";

		// Don't let one stale failure paint a long, mostly successful batch red
		// forever. Keep the failure count in the text, but reserve the red/error
		// treatment for the actionable case: the latest settled tool failed.
		const summaryColor =
			pendingTools.length > 0
				? "toolTitle"
				: failedCount > 0 && latestToolFailed(this.tools)
					? "error"
					: "muted";

		const lines = ["", truncateToWidth(fg(summaryColor, `${SUMMARY_INDENT}${summary}`), width, "…")];
		appendSkillInvocationLines(lines, skillInvocations, width);
		// While the batch is still running, show a dim, tree-connected preview of
		// the current tool's call (command / file path), capped at
		// PREVIEW_MAX_LINES. Only the first pending tool is previewed, and each
		// line is truncated (not wrapped), so the block height is bounded — no
		// layout shift when the model queues many calls at once. Skill reads already
		// get their durable explicit line above, so avoid duplicating their path.
		if (pendingTools.length > 0) {
			const previewTool = pendingTools[0];
			const preview = skillInvocationForTool(previewTool) ? [] : semanticPreviewLines(previewTool, PREVIEW_MAX_LINES);
			for (let i = 0; i < preview.length; i++) {
				const prefix = SUMMARY_INDENT + (i === 0 ? PREVIEW_CONNECTOR : PREVIEW_CONT_INDENT);
				const body = truncateToWidth(preview[i], Math.max(1, width - PREVIEW_PREFIX_WIDTH), "…");
				lines.push(truncateToWidth(fg("dim", prefix + body), width, "…"));
			}
		} else if (editDiffs.length > 0) {
			appendEditDiffLines(lines, editDiffs, width);
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

function hasAssistantStopNotice(message: any): boolean {
	if (!message || !Array.isArray(message.content)) return false;
	if (message.stopReason === "length") return true;
	const hasToolCalls = message.content.some((c: any) => c?.type === "toolCall");
	return !hasToolCalls && (message.stopReason === "aborted" || message.stopReason === "error");
}

function hasAssistantVisibleOutput(message: any): boolean {
	return hasVisibleAssistantText(message) || hasAssistantStopNotice(message);
}

function renderedHasVisibleAssistantOutput(comp: any, rendered: unknown): boolean {
	if (!Array.isArray(rendered)) return false;
	const hiddenThinkingLabel = stripAnsi(String(comp?.hiddenThinkingLabel ?? "Thinking...")).trim();
	for (const raw of rendered) {
		const plain = stripAnsi(String(raw)).trim();
		if (plain.length === 0) continue;
		if (hiddenThinkingLabel && plain === hiddenThinkingLabel) continue;
		return true;
	}
	return false;
}

function isIgnorableToolOnlyAssistant(child: any): boolean {
	return isAssistantComponent(child) && !hasAssistantVisibleOutput(child.lastMessage) && child.hasToolCalls === true;
}

// ---------------------------------------------------------------------------
// chatContainer.addChild interception (the batching engine)
// ---------------------------------------------------------------------------

const SYM_ORIG = Symbol.for("levi.pi.tool-batch-summary.orig");
const SYM_STATE = Symbol.for("levi.pi.tool-batch-summary.state");
const SYM_ARENDER = Symbol.for("levi.pi.tool-batch-summary.assistant-render-wrapped");
const SYM_AUPDATE = Symbol.for("levi.pi.tool-batch-summary.assistant-update-wrapped");

type BatchState = { batch: ToolBatchSummaryComponent | undefined };

// Can the current batch absorb the next tool? Only if everything added to the
// chat after the batch is an assistant turn with no visible user-facing output
// and confirmed tool calls (i.e. the streaming/finished assistant message that
// only thought + called tools).
function canReuseBatch(chat: any, state: BatchState): boolean {
	const batch = state.batch;
	if (!batch) return false;
	const children = chat.children;
	const idx = children.indexOf(batch);
	if (idx === -1) return false;
	for (let i = idx + 1; i < children.length; i++) {
		const child = children[i];
		if (isIgnorableToolOnlyAssistant(child)) continue;
		return false;
	}
	return true;
}

// Render-suppress an assistant component that would only show the collapsed
// "Thinking..." placeholder (thinking hidden, no visible text, tool-only turn).
function maybeWrapAssistantRender(comp: any, state?: BatchState): void {
	if (comp && state && !comp[SYM_AUPDATE] && typeof comp.updateContent === "function") {
		comp[SYM_AUPDATE] = true;
		const origUpdateContent = comp.updateContent.bind(comp);
		comp.updateContent = (message: any, ...args: any[]) => {
			const result = origUpdateContent(message, ...args);
			// If an assistant message gains visible user-facing output after it was
			// initially added as an empty streaming placeholder, end the current batch
			// immediately so any following tools render below that text instead of
			// being retroactively folded into the earlier summary.
			if (hasAssistantVisibleOutput(message)) {
				state.batch = undefined;
			}
			return result;
		};
	}

	if (!SUPPRESS_EMPTY_THINKING) return;
	if (!comp || comp[SYM_ARENDER]) return;
	if (typeof comp.render !== "function") return;
	comp[SYM_ARENDER] = true;
	const origRender = comp.render.bind(comp);
	comp.render = (width: number): string[] => {
		const rendered = origRender(width);
		if (
			comp.hideThinkingBlock &&
			comp.hasToolCalls &&
			!hasVisibleAssistantText(comp.lastMessage) &&
			!renderedHasVisibleAssistantOutput(comp, rendered)
		) {
			return [];
		}
		return rendered;
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
		maybeWrapAssistantRender(component, state);
		// An assistant turn with no visible user-facing output (only hidden
		// thinking + tool calls) must NOT break the batch — its tools should keep
		// grouping. If visible text/error appears now or during streaming, the
		// updateContent wrapper above clears state.batch so later tools start a new
		// summary below the assistant response.
		if (!hasAssistantVisibleOutput(component.lastMessage)) {
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
	semanticPreviewLines,
	latestToolFailed,
	collectEditDiffs,
	appendEditDiffLines,
	collectSkillInvocations,
	skillInvocationForTool,
	skillNameFromPath,
	hasAssistantVisibleOutput,
	renderedHasVisibleAssistantOutput,
	isIgnorableToolOnlyAssistant,
	ToolBatchSummaryComponent,
	setTheme: (t: any) => {
		THEME = t;
	},
};
