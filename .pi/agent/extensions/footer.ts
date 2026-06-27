import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { relative } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildSessionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

function runGit(cwd: string, args: string): string | null {
  try {
    return execSync(`git ${args}`, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function compactPath(path: string): string {
  const home = homedir();
  if (path === home) return "~";
  if (path.startsWith(`${home}/`)) return `~/${relative(home, path)}`;
  return path;
}

function getWorktree(cwd: string): string {
  const root = runGit(cwd, "rev-parse --show-toplevel") ?? cwd;
  return compactPath(root);
}

function formatTokens(count: number): string {
  if (!Number.isFinite(count)) return "?";
  if (count < 1000) return Math.round(count).toString();
  if (count < 1000000) return `${(count / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${(count / 1000000).toFixed(1).replace(/\.0$/, "")}M`;
}

// LM Studio (and most OpenAI-compatible providers) only expose the raw model
// `id` — there's no display-name field over the API — so derive a readable
// label from the id: "qwen/qwen3.6-35b-a3b" -> "Qwen3.6 35B A3B".
const MODEL_NAME_ACRONYMS: Record<string, string> = {
  gpt: "GPT",
  llm: "LLM",
  moe: "MoE",
  vl: "VL",
  ai: "AI",
};

function prettifyModelName(id: string): string {
  if (!id) return id;
  // Drop the publisher prefix ("qwen/…"), which is usually redundant with the slug.
  const base = id.includes("/") ? id.slice(id.indexOf("/") + 1) : id;
  return base
    .split("-")
    .map((part) => {
      if (!part) return part;
      const lower = part.toLowerCase();
      if (MODEL_NAME_ACRONYMS[lower]) return MODEL_NAME_ACRONYMS[lower];
      // Size/quant-style tokens (short and containing a digit): 35b, a3b, 7b, q4.
      if (/\d/.test(part) && part.length <= 4) return part.toUpperCase();
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(" ");
}

function modelLabel(model: { id?: string } | undefined): string {
  return model?.id ? prettifyModelName(model.id) : "no model";
}

function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function estimateGenericContent(content: unknown): number {
  if (typeof content === "string") return estimateTextTokens(content);
  if (!Array.isArray(content)) return 0;

  let chars = 0;
  for (const block of content as Array<{ type?: string; text?: string }>) {
    if (block.type === "text" && block.text) chars += block.text.length;
  }
  return Math.ceil(chars / 4);
}

function estimateMessageTokens(message: unknown): number {
  const msg = message as { role?: string; content?: unknown };

  if (msg.role === "user" || msg.role === "toolResult") {
    return estimateGenericContent(msg.content);
  }

  if (msg.role === "assistant" && Array.isArray(msg.content)) {
    let chars = 0;
    for (const block of msg.content as Array<{
      type?: string;
      text?: string;
      thinking?: string;
      name?: string;
      arguments?: unknown;
    }>) {
      if (block.type === "text" && block.text) chars += block.text.length;
      else if (block.type === "thinking" && block.thinking) chars += block.thinking.length;
      else if (block.type === "toolCall") chars += (block.name?.length ?? 0) + JSON.stringify(block.arguments ?? {}).length;
    }
    return Math.ceil(chars / 4);
  }

  return estimateGenericContent(msg.content);
}

// Mirrors @mrclrchtr/supi-context's fallback path: Pi's ctx.getContextUsage()
// can be 0/null before the first measured provider response, so include the
// live system prompt plus the current branch messages instead of showing 0.
function estimateSupiStyleContextUsage(
  ctx: ExtensionContext,
): { tokens: number | null; contextWindow: number; percent: number | null } | undefined {
  const measuredUsage = ctx.getContextUsage();
  const contextWindow = measuredUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
  if (contextWindow <= 0) return measuredUsage;

  if (measuredUsage?.tokens != null && measuredUsage.tokens > 0) {
    return measuredUsage;
  }

  const apiView = buildSessionContext(ctx.sessionManager.getBranch());
  const estimatedTokens = estimateTextTokens(ctx.getSystemPrompt()) + apiView.messages.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0);
  const tokens = estimatedTokens > 0 ? estimatedTokens : (measuredUsage?.tokens ?? null);

  return {
    tokens,
    contextWindow,
    percent: tokens == null ? null : (tokens / contextWindow) * 100,
  };
}

function formatContextUsage(
  usage: { tokens: number | null; contextWindow: number; percent: number | null } | undefined,
): string {
  if (!usage) return "context unknown";

  const window = formatTokens(usage.contextWindow);
  if (usage.tokens == null) return `?/${window}`;

  return `${formatTokens(usage.tokens)}/${window}`;
}

const OPENAI_CODEX_USAGE_STATUS_KEY = "aa-openai-codex-usage";
const RECAP_STATUS_KEY = "zz-recap";
const OPENAI_CODEX_USAGE_GLOBAL_KEY = Symbol.for("lepi.openaiCodexUsage");
const SUBSCRIPTION_USAGE_STALE_MS = 10 * 60 * 1000;

function sessionCost(ctx: { sessionManager: { getEntries(): readonly unknown[] } }): number {
  let total = 0;
  for (const entry of ctx.sessionManager.getEntries()) {
    const message = (entry as any)?.message;
    if ((entry as any)?.type === "message" && message?.role === "assistant") {
      total += message.usage?.cost?.total ?? 0;
    }
  }
  return total;
}

function subscriptionUsageText(): { label: string; pct: number } | undefined {
  const store = (globalThis as any)[OPENAI_CODEX_USAGE_GLOBAL_KEY];
  const snapshot = store?.snapshot;
  const updatedAt = snapshot?.updatedAt;
  if (typeof updatedAt !== "number") return undefined;
  if (Date.now() - updatedAt > SUBSCRIPTION_USAGE_STALE_MS) return undefined;
  const primary = snapshot?.primary;
  if (!primary || !primary.label) return undefined;
  return { label: primary.label, pct: Math.round(primary.usedPercent) };
}

function sanitizeFooterLine(text: string): string {
  return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

function joinFooter(left: string, rightCandidates: readonly string[], width: number, rightSeparator = " "): string {
  let right = rightCandidates.join(rightSeparator);

  while (right && visibleWidth(left) + 2 + visibleWidth(right) > width && rightCandidates.length > 1) {
    rightCandidates = rightCandidates.slice(1);
    right = rightCandidates.join(rightSeparator);
  }

  if (!right) return truncateToWidth(left, width);

  const availableForRight = width - visibleWidth(left) - 2;
  if (availableForRight <= 0) return truncateToWidth(left, width);

  right = truncateToWidth(right, availableForRight, "");
  const pad = " ".repeat(Math.max(2, width - visibleWidth(left) - visibleWidth(right)));
  return truncateToWidth(left + pad + right, width);
}

// Throughput is reported once per back-and-forth, not per message. We tally
// output tokens and generation time across every assistant message in the prompt
// (tool-calling turns included, tool wait time excluded) and only publish a
// tok/sec figure when the agent loop closes — i.e. the final response is
// delivered to the user, or the user interrupts the stream.
let lastTokensPerSecond: number | undefined;
let genStartMs: number | undefined;
let accumulatedOutputTokens = 0;
let accumulatedGenMs = 0;
let requestFooterRender: (() => void) | undefined;

function formatTokensPerSecond(): string | undefined {
  if (lastTokensPerSecond == null || !Number.isFinite(lastTokensPerSecond) || lastTokensPerSecond <= 0) {
    return undefined;
  }
  return `${lastTokensPerSecond.toFixed(2)} tok/sec`;
}

export default function (pi: ExtensionAPI) {
  // A new back-and-forth has begun: drop the previous reading so the footer
  // doesn't show a stale tok/sec while the model is generating, and start a
  // fresh tally for this prompt.
  pi.on("agent_start", async () => {
    lastTokensPerSecond = undefined;
    accumulatedOutputTokens = 0;
    accumulatedGenMs = 0;
    genStartMs = undefined;
    requestFooterRender?.();
  });

  pi.on("message_start", async (event) => {
    if ((event.message as { role?: string })?.role === "assistant") genStartMs = Date.now();
  });

  pi.on("message_end", async (event) => {
    const message = event.message as { role?: string; usage?: { output?: number } };
    if (message?.role !== "assistant") return;
    // Some providers (e.g. LM Studio) report usage.output as 0; fall back to
    // estimating output tokens from the assistant message content.
    const reported = message.usage?.output ?? 0;
    const output = reported > 0 ? reported : estimateMessageTokens(message);
    if (genStartMs != null && output > 0) {
      const elapsedMs = Date.now() - genStartMs;
      if (elapsedMs > 0) {
        // Accumulate only — this message may just be a tool-calling turn, not
        // the final response. The rate is published once at agent_end so a tool
        // call (or any intermediate message) never moves the footer.
        accumulatedOutputTokens += output;
        accumulatedGenMs += elapsedMs;
      }
    }
    genStartMs = undefined;
  });

  // The agent loop has closed: the final response reached the user, or the user
  // interrupted the stream. Either way, publish the throughput for the whole
  // response (total generated tokens over total generation time).
  pi.on("agent_end", async () => {
    if (accumulatedOutputTokens > 0 && accumulatedGenMs > 0) {
      lastTokensPerSecond = accumulatedOutputTokens / (accumulatedGenMs / 1000);
    }
    requestFooterRender?.();
  });

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;

    ctx.ui.setFooter((tui, theme, footerData) => {
      const unsub = footerData.onBranchChange(() => tui.requestRender());
      const worktree = getWorktree(ctx.cwd);
      requestFooterRender = () => tui.requestRender();

      return {
        dispose() {
          unsub();
          requestFooterRender = undefined;
        },
        invalidate() {},
        render(width: number): string[] {
          const branch = footerData.getGitBranch() ?? runGit(ctx.cwd, "branch --show-current") ?? "detached";
          const extensionStatuses = footerData.getExtensionStatuses();
          const recapLine = extensionStatuses.get(RECAP_STATUS_KEY);
          const statuses = [...extensionStatuses.entries()]
            .filter(([key, value]) => key !== OPENAI_CODEX_USAGE_STATUS_KEY && key !== RECAP_STATUS_KEY && Boolean(value))
            .map(([, value]) => sanitizeFooterLine(value))
            .filter(Boolean)
            .join(theme.fg("dim", " • "));
          const model = modelLabel(ctx.model);

          const contextUsage = estimateSupiStyleContextUsage(ctx);
          const contextText = formatContextUsage(contextUsage);
          const contextPart = contextUsage?.tokens == null
            ? theme.fg("dim", contextText)
            : `${theme.fg("warning", formatTokens(contextUsage.tokens))}${theme.fg("muted", `/${formatTokens(contextUsage.contextWindow)}`)}`;
          const costValue = sessionCost(ctx);
          const cost = costValue > 0 ? theme.fg("muted", `$${costValue.toFixed(5)}`) : undefined;
          const subscriptionUsage = subscriptionUsageText();
          const separator = theme.fg("dim", " • ");
          const subLine = subscriptionUsage
            ? `${theme.fg("muted", subscriptionUsage.label)} ${theme.fg("text", `${subscriptionUsage.pct}%`)}`
            : undefined;
          const tokensPerSecond = formatTokensPerSecond();
          const left = [
            contextPart,
            theme.fg("muted", model),
            tokensPerSecond ? theme.fg("muted", tokensPerSecond) : undefined,
            subLine,
            cost,
          ].filter(Boolean).join(separator);

          const worktreePart = theme.fg("muted", worktree);
          const branchPart = theme.fg("accent", branch);
          const directoryBranch = `${worktreePart} ${theme.fg("dim", "•")} ${branchPart}`;
          const rightCandidates = [
            directoryBranch,
            statuses,
          ].filter(Boolean);

          const lines = [joinFooter(left, rightCandidates, width, separator)];
          if (recapLine) {
            lines.push(truncateToWidth(theme.fg("dim", sanitizeFooterLine(recapLine)), width, theme.fg("dim", "...")));
          }
          return lines;
        },
      };
    });
  });

  pi.registerCommand("builtin-footer", {
    description: "Restore Pi's built-in footer",
    handler: async (_args, ctx) => {
      ctx.ui.setFooter(undefined);
      ctx.ui.notify("Built-in footer restored", "info");
    },
  });
}
