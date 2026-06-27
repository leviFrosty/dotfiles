import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { relative } from "node:path";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { SettingsManager, VERSION } from "@earendil-works/pi-coding-agent";

const LEPI_ASCII = [
  "██╗     ███████╗██████╗ ██╗",
  "██║     ██╔════╝██╔══██╗██║",
  "██║     █████╗  ██████╔╝██║",
  "██║     ██╔══╝  ██╔═══╝ ██║",
  "███████╗███████╗██║     ██║",
  "╚══════╝╚══════╝╚═╝     ╚═╝",
];

const CONTROL_HINTS = "esc interrupt • ctrl+c/ctrl+d clear/exit • / commands • ! bash • ctrl+o more";

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

function getShowAsciiMotd(ctx: ExtensionContext): boolean {
  return SettingsManager.create(ctx.cwd, undefined, { projectTrusted: ctx.isProjectTrusted() }).getShowAsciiMotd();
}

function renderMotd(theme: Theme, ctx: { cwd: string; model?: { id?: string } }, options: { showAsciiMotd?: boolean } = {}): string[] {
  const brand = (text: string) => theme.fg("accent", text);
  const muted = (text: string) => theme.fg("muted", text);
  const dim = (text: string) => theme.fg("dim", text);
  const worktree = getWorktree(ctx.cwd);
  const branch = runGit(ctx.cwd, "branch --show-current") ?? "detached";
  const model = modelLabel(ctx.model);
  const ascii = options.showAsciiMotd === false ? [] : ["", ...LEPI_ASCII.map(brand), ""];

  return [
    ...ascii,
    `${brand("LePi")} ${muted("coding agent")} ${dim(`version: v${VERSION}`)}, ${dim("•")} ${muted(model)} ${dim("•")} ${muted(`${worktree} @ ${branch}`)}`,
    "",
    dim(CONTROL_HINTS),
  ];
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;

    const showAsciiMotd = getShowAsciiMotd(ctx);

    ctx.ui.setHeader((_tui, theme) => ({
      invalidate() { },
      render(_width: number): string[] {
        return renderMotd(theme, ctx, { showAsciiMotd });
      },
    }));
  });

  pi.registerCommand("builtin-motd", {
    description: "Restore Pi's built-in startup header",
    handler: async (_args, ctx) => {
      ctx.ui.setHeader(undefined);
      ctx.ui.notify("Built-in startup header restored", "info");
    },
  });
}
