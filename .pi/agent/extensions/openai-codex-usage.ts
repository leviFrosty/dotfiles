import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "aa-openai-codex-usage";
const GLOBAL_KEY = Symbol.for("lepi.openaiCodexUsage");
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const REFRESH_INTERVAL_MS = 30_000;
const REQUEST_TIMEOUT_MS = 15_000;
const STALE_AFTER_MS = 10 * 60_000;
const CODEX_PROVIDER_ID = "openai-codex";
const SPARK_MODEL_KEY = "gpt-5.3-codex-spark";

type UsageWindowSnapshot = {
  label: string;
  usedPercent: number;
  resetAt?: number;
};

type UsageSnapshot = {
  display: string;
  updatedAt: number;
  planType?: string;
  source: "chatgpt-usage";
  primary?: UsageWindowSnapshot;
  secondary?: UsageWindowSnapshot;
};

type UsageStore = {
  snapshot?: UsageSnapshot;
  error?: string;
  inFlight?: boolean;
  updatedAt?: number;
};

function store(): UsageStore {
  return ((globalThis as any)[GLOBAL_KEY] ??= {}) as UsageStore;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(number) ? number : undefined;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  return Object.keys(headers).some((key) => key.toLowerCase() === name.toLowerCase());
}

function formatWindowLabel(seconds: number | undefined, fallback: string): string {
  if (!seconds || seconds <= 0) return fallback;
  const day = 24 * 60 * 60;
  const hour = 60 * 60;
  if (seconds % day === 0) return `${seconds / day}d`;
  if (seconds % hour === 0) return `${seconds / hour}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

function normalizeWindow(value: unknown, fallbackLabel: string): UsageWindowSnapshot | undefined {
  const window = asObject(value);
  if (!window) return undefined;
  const rawUsed = asFiniteNumber(window.used_percent);
  if (rawUsed === undefined) return undefined;

  const seconds = asFiniteNumber(window.limit_window_seconds);
  const resetAt = asFiniteNumber(window.reset_at);
  const resetAfter = asFiniteNumber(window.reset_after_seconds);

  return {
    label: formatWindowLabel(seconds, fallbackLabel),
    usedPercent: clampPercent(rawUsed),
    resetAt: resetAt ?? (resetAfter === undefined ? undefined : Math.round(Date.now() / 1000 + resetAfter)),
  };
}

function isSparkModel(modelId: string | undefined): boolean {
  return (modelId ?? "").toLowerCase() === SPARK_MODEL_KEY;
}

function selectRateLimitBucket(payload: Record<string, unknown>, modelId: string | undefined): Record<string, unknown> | undefined {
  if (!isSparkModel(modelId)) return asObject(payload.rate_limit);

  const additional = Array.isArray(payload.additional_rate_limits)
    ? payload.additional_rate_limits
    : Object.values(asObject(payload.additional_rate_limits) ?? {});

  for (const item of additional) {
    const record = asObject(item);
    const name = String(record?.limit_name ?? "").toLowerCase();
    if (name.includes("spark")) return asObject(record?.rate_limit);
  }

  return asObject(payload.rate_limit);
}

function formatSnapshot(snapshot: Pick<UsageSnapshot, "primary" | "secondary">): string {
  return [snapshot.primary, snapshot.secondary]
    .filter(Boolean)
    .map((window) => {
      const pct = `${Math.round(window!.usedPercent)}%`;
      if (!window?.resetAt) return `${window!.label} ${pct}`;
      const resetDate = new Date(window.resetAt * 1000);
      const time = resetDate.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: true });
      const isSecondary = window === snapshot.secondary;
      if (isSecondary) {
        const monthDay = resetDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
        return `${window!.label} ${pct} resets ${monthDay} at ${time}`;
      }
      return `${window!.label} ${pct} resets ${time}`;
    })
    .join(", ");
}

function normalizePayload(payload: unknown, modelId: string | undefined): UsageSnapshot | undefined {
  const root = asObject(payload);
  if (!root) return undefined;
  const bucket = selectRateLimitBucket(root, modelId);
  if (!bucket) return undefined;

  const primary = normalizeWindow(bucket.primary_window, "5h");
  const secondary = normalizeWindow(bucket.secondary_window, "7d");
  const display = formatSnapshot({ primary, secondary });
  if (!display) return undefined;

  return {
    display,
    updatedAt: Date.now(),
    planType: typeof root.plan_type === "string" ? root.plan_type : undefined,
    source: "chatgpt-usage",
    primary,
    secondary,
  };
}

function activeCodexModel(ctx: ExtensionContext): any | undefined {
  const model = ctx.model as any;
  if (!model || model.provider !== CODEX_PROVIDER_ID) return undefined;
  return model;
}

function codexAuthCandidates(ctx: ExtensionContext, activeModel: any): any[] {
  const seen = new Set<string>();
  const candidates = [activeModel, ...ctx.modelRegistry.getAvailable().filter((model: any) => model.provider === CODEX_PROVIDER_ID)];

  return candidates.filter((model: any) => {
    const key = `${model.provider}/${model.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function resolveCodexAuth(ctx: ExtensionContext, activeModel: any): Promise<Record<string, string> | undefined> {
  for (const model of codexAuthCandidates(ctx, activeModel)) {
    if (!ctx.modelRegistry.isUsingOAuth(model)) continue;
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) continue;

    const headers: Record<string, string> = { ...(auth.headers ?? {}) };
    if (!hasHeader(headers, "Authorization") && auth.apiKey) headers.Authorization = `Bearer ${auth.apiKey}`;
    if (!hasHeader(headers, "Accept")) headers.Accept = "*/*";
    if (!hasHeader(headers, "User-Agent")) headers["User-Agent"] = "lepi-openai-codex-usage";
    if (hasHeader(headers, "Authorization")) return headers;
  }

  return undefined;
}

async function fetchUsage(headers: Record<string, string>, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(USAGE_URL, { headers, signal });
  const text = await response.text();
  if (!response.ok) throw new Error(`Codex usage request failed (${response.status}): ${text.slice(0, 160)}`);
  return JSON.parse(text) as unknown;
}

function publish(ctx: ExtensionContext, snapshot: UsageSnapshot | undefined, error?: string) {
  const usageStore = store();
  usageStore.snapshot = snapshot;
  usageStore.error = error;
  usageStore.updatedAt = Date.now();

  try {
    ctx.ui.setStatus(STATUS_KEY, snapshot ? `codex ${snapshot.display}` : undefined);
  } catch {
    // Session may be shutting down; never let background quota polling crash Pi.
  }
}

export default function openAICodexUsageExtension(pi: ExtensionAPI) {
  let generation = 0;
  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  let activeAbort: AbortController | undefined;
  let refreshCurrent: (() => void) | undefined;

  const stop = () => {
    generation += 1;
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = undefined;
    refreshCurrent = undefined;
    activeAbort?.abort();
    activeAbort = undefined;
    store().inFlight = false;
  };

  const refreshUsage = async (ctx: ExtensionContext, currentGeneration: number) => {
    const usageStore = store();
    if (usageStore.inFlight) return;

    const model = activeCodexModel(ctx);
    if (!model || !ctx.modelRegistry.isUsingOAuth(model)) {
      publish(ctx, undefined);
      return;
    }

    usageStore.inFlight = true;
    const controller = new AbortController();
    activeAbort = controller;
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const headers = await resolveCodexAuth(ctx, model);
      if (!headers) throw new Error("No OpenAI Codex OAuth auth available.");
      const payload = await fetchUsage(headers, controller.signal);
      const snapshot = normalizePayload(payload, model.id);
      if (!snapshot) throw new Error("Codex usage response had no displayable usage windows.");
      if (currentGeneration !== generation) return;
      publish(ctx, snapshot);
    } catch (error) {
      if (currentGeneration !== generation) return;
      const previous = usageStore.snapshot;
      const previousIsFresh = previous && Date.now() - previous.updatedAt < STALE_AFTER_MS;
      publish(ctx, previousIsFresh ? previous : undefined, error instanceof Error ? error.message : String(error));
    } finally {
      clearTimeout(timeout);
      if (activeAbort === controller) activeAbort = undefined;
      usageStore.inFlight = false;
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    stop();
    const currentGeneration = ++generation;
    refreshCurrent = () => void refreshUsage(ctx, currentGeneration);
    refreshCurrent();
    refreshTimer = setInterval(refreshCurrent, REFRESH_INTERVAL_MS);
  });

  pi.on("model_select", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    void refreshUsage(ctx, generation);
  });

  pi.on("session_shutdown", async () => {
    stop();
  });

  pi.registerCommand("codex-usage-refresh", {
    description: "Refresh OpenAI Codex subscription usage now",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("Codex usage footer polling only runs in TUI mode.", "warning");
        return;
      }
      const currentGeneration = generation;
      await refreshUsage(ctx, currentGeneration);
      const snapshot = store().snapshot;
      ctx.ui.notify(snapshot ? `Codex usage: ${snapshot.display}` : `Codex usage unavailable: ${store().error ?? "no data"}`, snapshot ? "info" : "warning");
    },
  });
}
