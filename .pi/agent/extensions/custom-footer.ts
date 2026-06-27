import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { relative } from "node:path";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { buildSessionContext, VERSION } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const LEPI_ASCII = [
  "██╗     ███████╗██████╗ ██╗",
  "██║     ██╔════╝██╔══██╗██║",
  "██║     █████╗  ██████╔╝██║",
  "██║     ██╔══╝  ██╔═══╝ ██║",
  "███████╗███████╗██║     ██║",
  "╚══════╝╚══════╝╚═╝     ╚═╝",
];

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

function getHeaderLines(theme: Theme, ctx: { cwd: string; model?: { id?: string } }): string[] {
  const brand = (text: string) => theme.fg("accent", text);
  const muted = (text: string) => theme.fg("muted", text);
  const dim = (text: string) => theme.fg("dim", text);
  const worktree = getWorktree(ctx.cwd);
  const branch = runGit(ctx.cwd, "branch --show-current") ?? "detached";
  const model = ctx.model?.id ?? "no model";

  return [
    "",
    ...LEPI_ASCII.map(brand),
    "",
    `${brand("LePi")} ${muted("coding agent")} ${dim("•")} ${muted(model)} ${dim("•")} ${muted(`${worktree} @ ${branch}`)}`,
    dim(`version: v${VERSION}`),
    "",
    dim("esc interrupt • ctrl+c/ctrl+d clear/exit • / commands • ! bash • ctrl+o more"),
    dim("Welcome back. Ask LePi to build, debug, explain, or look up docs."),
  ];
}

function formatTokens(count: number): string {
  if (!Number.isFinite(count)) return "?";
  if (count < 1000) return Math.round(count).toString();
  if (count < 1000000) return `${(count / 1000).toFixed(1)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
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

function formatPercent(percent: number | null | undefined): string {
  if (percent == null || !Number.isFinite(percent)) return "?%";
  return `${percent.toFixed(1)}%`;
}

function formatContextUsage(
  usage: { tokens: number | null; contextWindow: number; percent: number | null } | undefined,
): string {
  if (!usage) return "context unknown";

  const window = formatTokens(usage.contextWindow);
  if (usage.tokens == null) return `? / ${window} tokens (${formatPercent(null)})`;

  return `${formatTokens(usage.tokens)} / ${window} tokens (${formatPercent(usage.percent)})`;
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

function subscriptionUsageText(): string | undefined {
  const store = (globalThis as any)[OPENAI_CODEX_USAGE_GLOBAL_KEY];
  const display = store?.snapshot?.display;
  const updatedAt = store?.snapshot?.updatedAt;
  if (typeof display !== "string" || display.length === 0 || typeof updatedAt !== "number") return undefined;
  if (Date.now() - updatedAt > SUBSCRIPTION_USAGE_STALE_MS) return undefined;
  return display;
}

function sanitizeFooterLine(text: string): string {
  return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

function joinFooter(left: string, rightCandidates: readonly string[], width: number): string {
  let right = rightCandidates.join(" ");

  while (right && visibleWidth(left) + 2 + visibleWidth(right) > width && rightCandidates.length > 1) {
    rightCandidates = rightCandidates.slice(1);
    right = rightCandidates.join(" ");
  }

  if (!right) return truncateToWidth(left, width);

  const availableForRight = width - visibleWidth(left) - 2;
  if (availableForRight <= 0) return truncateToWidth(left, width);

  right = truncateToWidth(right, availableForRight, "");
  const pad = " ".repeat(Math.max(2, width - visibleWidth(left) - visibleWidth(right)));
  return truncateToWidth(left + pad + right, width);
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;

    ctx.ui.setHeader((_tui, theme) => ({
      invalidate() {},
      render(_width: number): string[] {
        return getHeaderLines(theme, ctx);
      },
    }));

    ctx.ui.setFooter((tui, theme, footerData) => {
      const unsub = footerData.onBranchChange(() => tui.requestRender());
      const worktree = getWorktree(ctx.cwd);

      return {
        dispose: unsub,
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
          const model = ctx.model?.id ?? "no model";

          const contextUsage = estimateSupiStyleContextUsage(ctx);
          const contextText = formatContextUsage(contextUsage);
          const cost = `$${sessionCost(ctx).toFixed(5)}`;
          const subscriptionUsage = subscriptionUsageText();
          const separator = theme.fg("dim", " | ");
          const left = [
            theme.fg(contextUsage?.tokens == null ? "dim" : "warning", contextText),
            theme.fg("dim", cost),
            subscriptionUsage ? theme.fg("dim", subscriptionUsage) : undefined,
          ].filter(Boolean).join(separator);

          const worktreePart = theme.fg("muted", worktree);
          const branchPart = theme.fg("accent", branch);
          const directoryBranch = `${worktreePart} ${theme.fg("dim", "•")} ${branchPart}`;
          const rightCandidates = [
            directoryBranch,
            statuses,
            theme.fg("dim", model),
          ].filter(Boolean);

          const lines = [joinFooter(left, rightCandidates, width)];
          if (recapLine) {
            lines.push(truncateToWidth(theme.fg("dim", sanitizeFooterLine(recapLine)), width, theme.fg("dim", "...")));
          }
          return lines;
        },
      };
    });
  });

  pi.registerCommand("builtin-chrome", {
    description: "Restore Pi's built-in header and footer",
    handler: async (_args, ctx) => {
      ctx.ui.setHeader(undefined);
      ctx.ui.setFooter(undefined);
      ctx.ui.notify("Built-in header/footer restored", "info");
    },
  });
}
