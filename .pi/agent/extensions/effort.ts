import { DynamicBorder, keyHint, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { Container, Key, Text, matchesKey, truncateToWidth, type AutocompleteItem } from "@earendil-works/pi-tui";
import {
	capabilitiesFromPi,
	capabilitiesFromProviderCatalog,
	completionAliases,
	effortLabel,
	modelKey,
	normalizeEffort,
	parseEffort,
	type EffortCapabilities,
	type EffortOption,
} from "./effort/capabilities.ts";
import { loadProviderCatalog } from "./effort/provider-catalog.ts";

const SELECTION_ENTRY = "effort-selection";
const INFO_ENTRY = "effort-info";

interface PersistedSelection {
	modelKey: string;
	effort: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function persistedSelection(ctx: ExtensionContext, key: string): string | undefined {
	const branch = ctx.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry?.type !== "custom" || entry.customType !== SELECTION_ENTRY || !isRecord(entry.data)) continue;
		if (entry.data.modelKey === key && typeof entry.data.effort === "string") return entry.data.effort;
	}
	return undefined;
}

function sourceLabel(capabilities: EffortCapabilities): string {
	switch (capabilities.source) {
		case "provider-catalog":
			return `live provider catalog${capabilities.fetchedAt ? ` (cached ${capabilities.fetchedAt})` : ""}`;
		case "stale-provider-catalog":
			return `stale provider catalog${capabilities.fetchedAt ? ` (${capabilities.fetchedAt})` : ""}`;
		case "pi-model-metadata":
			return "Pi model metadata";
	}
}

function optionDetails(option: EffortOption): string {
	const mapping =
		option.mappedValue && option.mappedValue !== option.id
			? `Pi ${option.piLevel} → provider "${option.mappedValue}"`
			: `Pi ${option.piLevel}`;
	return `${option.label} (${option.id}; ${mapping})${option.description ? ` — ${option.description}` : ""}`;
}

export default function effortExtension(pi: ExtensionAPI) {
	let capabilities: EffortCapabilities | undefined;
	let selectedId: string | undefined;
	let pendingPiLevel: ModelThinkingLevel | undefined;
	let refreshGeneration = 0;
	let initialized = false;

	const currentOption = (): EffortOption | undefined => capabilities?.options.find((option) => option.id === selectedId);

	const appendInfo = (content: string) => {
		pi.appendEntry(INFO_ENTRY, { content });
	};

	const recordSelection = (option: EffortOption) => {
		if (!capabilities) return;
		pi.appendEntry(SELECTION_ENTRY, {
			modelKey: capabilities.modelKey,
			effort: option.id,
		} satisfies PersistedSelection);
	};

	const updateStatus = (ctx: ExtensionContext) => {
		const option = currentOption();
		const piLevel = option?.piLevel ?? (pi.getThinkingLevel() as ModelThinkingLevel);
		const color = ctx.ui.theme.getThinkingBorderColor(piLevel);
		const label = option?.label ?? effortLabel(piLevel);
		ctx.ui.setStatus("effort", color(label));
	};

	const details = (ctx: ExtensionContext, heading = "Effort capabilities"): string => {
		const model = ctx.model;
		if (!model || !capabilities) return `${heading}\nModel: (no model selected)\nAvailable: none`;
		const option = currentOption();
		const ignored = capabilities.ignoredProviderLevels ?? [];
		return [
			heading,
			`Model: ${capabilities.modelKey}`,
			`Source: ${sourceLabel(capabilities)}`,
			`Current effort: ${option?.label ?? "unknown"}${option ? ` (${option.id})` : ""}`,
			"Available:",
			...capabilities.options.map((candidate) => `  - ${optionDetails(candidate)}`),
			...(ignored.length > 0
				? [
						"Catalog-only modes not exposed by Pi's model/transport:",
						...ignored.map(
							(level) => `  - ${effortLabel(level.id)} (${level.id})${level.description ? ` — ${level.description}` : ""}`,
						),
					]
				: []),
			...(capabilities.warning ? [`Warning: ${capabilities.warning}`] : []),
		].join("\n");
	};

	const applyOption = (
		ctx: ExtensionContext,
		option: EffortOption,
		options: { persist: boolean; notify: boolean },
	): boolean => {
		const previousId = selectedId;
		selectedId = option.id;

		if (pi.getThinkingLevel() !== option.piLevel) {
			pendingPiLevel = option.piLevel;
			pi.setThinkingLevel(option.piLevel);
		}
		const effective = pi.getThinkingLevel() as ModelThinkingLevel;
		if (effective !== option.piLevel) {
			selectedId = capabilities?.options.find((candidate) => candidate.piLevel === effective)?.id;
			const reason = `Pi clamped ${option.label} to ${effortLabel(effective)} for ${capabilities?.modelKey ?? "the active model"}.`;
			appendInfo(details(ctx, reason));
			ctx.ui.notify(reason, "warning");
			updateStatus(ctx);
			return false;
		}

		if (options.persist) recordSelection(option);
		updateStatus(ctx);
		if (options.notify) {
			ctx.ui.notify(previousId === option.id ? `Effort already ${option.label}` : `Effort set to ${option.label}`, "info");
		}
		return true;
	};

	const synchronizeModel = async (
		ctx: ExtensionContext,
		options: { force?: boolean; restore?: boolean } = {},
	): Promise<void> => {
		const model = ctx.model;
		const generation = ++refreshGeneration;
		if (!model) {
			capabilities = undefined;
			selectedId = undefined;
			updateStatus(ctx);
			return;
		}

		const key = modelKey(model);
		let next = capabilitiesFromPi(model);
		capabilities = next;

		const catalog = await loadProviderCatalog(model, ctx.modelRegistry, { force: options.force });
		if (generation !== refreshGeneration || !ctx.model || modelKey(ctx.model) !== key) return;
		if (catalog?.model) {
			next =
				capabilitiesFromProviderCatalog(model, catalog.model, {
					stale: catalog.stale,
					fetchedAt: catalog.fetchedAt,
					warning: catalog.warning,
				}) ?? next;
		} else if (catalog?.fetchedAt) {
			// A valid provider catalog that omits the active model is authoritative:
			// the safe intersection is empty, not Pi's broader static defaults.
			next = {
				modelKey: key,
				options: [],
				source: catalog.stale ? "stale-provider-catalog" : "provider-catalog",
				fetchedAt: catalog.fetchedAt,
				warning: catalog.warning ?? "The active model was absent from the provider catalog.",
			};
		} else if (catalog) {
			next = { ...next, warning: catalog.warning };
		}
		capabilities = next;

		const savedId = options.restore ? persistedSelection(ctx, key) : selectedId;
		const piLevel = pi.getThinkingLevel() as ModelThinkingLevel;
		const option =
			next.options.find((candidate) => candidate.id === savedId) ??
			next.options.find((candidate) => candidate.id === piLevel) ??
			next.options.find((candidate) => candidate.piLevel === piLevel) ??
			next.options.find((candidate) => candidate.id === next.defaultId) ??
			next.options[0];
		if (option) {
			applyOption(ctx, option, { persist: false, notify: false });
		} else {
			selectedId = undefined;
			updateStatus(ctx);
		}
	};

	const showSlider = async (ctx: ExtensionContext): Promise<void> => {
		if (ctx.mode !== "tui") {
			appendInfo(details(ctx, "/effort without an argument requires TUI mode."));
			return;
		}
		if (!capabilities || capabilities.options.length === 0) {
			appendInfo(details(ctx, "No effort levels are available for the active model."));
			return;
		}

		const options = capabilities.options;
		let selectedIndex = Math.max(0, options.findIndex((option) => option.id === selectedId));
		const result = await ctx.ui.custom<EffortOption | null>((tui, theme, keybindings, done) => {
			const renderSlider = (width: number): string[] => {
				const container = new Container();
				container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
				container.addChild(new Text(theme.fg("accent", theme.bold("Effort Level")), 1, 0));
				container.addChild(new Text(theme.fg("muted", capabilities?.modelKey ?? "(no model selected)"), 1, 0));
				const chunks = options.map((option, index) => {
					const label = index === selectedIndex ? `[${option.label}]` : ` ${option.label} `;
					return index === selectedIndex ? theme.fg("accent", theme.bold(label)) : theme.fg("muted", label);
				});
				container.addChild(new Text(chunks.join(theme.fg("dim", " ─ ")), 1, 1));
				container.addChild(new Text(theme.fg("dim", options[selectedIndex]?.description ?? ""), 1, 0));
				container.addChild(
					new Text(
						theme.fg(
							"dim",
							`tab/shift+tab or arrows change • ${keyHint("tui.select.confirm", "apply")} • ${keyHint("tui.select.cancel", "cancel")}`,
						),
						1,
						0,
					),
				);
				container.addChild(new Text(theme.fg("dim", `Source: ${sourceLabel(capabilities!)}`), 1, 0));
				container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
				return container.render(width).map((line) => truncateToWidth(line, width));
			};

			return {
				render: renderSlider,
				invalidate() {},
				handleInput(data: string) {
					if (
						keybindings.matches(data, "tui.select.down") ||
						matchesKey(data, Key.right) ||
						matchesKey(data, Key.tab)
					) {
						selectedIndex = (selectedIndex + 1) % options.length;
						tui.requestRender();
						return;
					}
					if (
						keybindings.matches(data, "tui.select.up") ||
						matchesKey(data, Key.left) ||
						matchesKey(data, Key.shift("tab"))
					) {
						selectedIndex = (selectedIndex - 1 + options.length) % options.length;
						tui.requestRender();
						return;
					}
					if (keybindings.matches(data, "tui.select.confirm")) return done(options[selectedIndex] ?? null);
					if (keybindings.matches(data, "tui.select.cancel")) done(null);
				},
			};
		});

		if (result) applyOption(ctx, result, { persist: true, notify: true });
	};

	pi.registerEntryRenderer(INFO_ENTRY, (entry, _options, theme) => {
		const content = isRecord(entry.data) && typeof entry.data.content === "string" ? entry.data.content : "";
		return new Text(`${theme.fg("customMessageLabel", "effort")}\n${content}`, 1, 0);
	});

	pi.registerCommand("effort", {
		description: "Use only the active model's effort levels; /effort refresh|status",
		getArgumentCompletions(prefix: string): AutocompleteItem[] | null {
			const normalized = normalizeEffort(prefix);
			const effortItems: AutocompleteItem[] = completionAliases(capabilities?.options ?? []).map(({ value, option }) => ({
				value,
				label: value,
				description: option.description ?? `Set effort to ${option.label}`,
			}));
			const commandItems: AutocompleteItem[] = [
				{ value: "status", label: "status", description: "Show active model effort capabilities" },
				{ value: "refresh", label: "refresh", description: "Refresh the provider capability catalog" },
			];
			const items = [...effortItems, ...commandItems].filter((item) => item.value.startsWith(normalized));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const raw = (args ?? "").trim();
			if (!raw) return showSlider(ctx);
			const normalized = normalizeEffort(raw);
			if (normalized === "status") {
				appendInfo(details(ctx));
				return;
			}
			if (normalized === "refresh") {
				await synchronizeModel(ctx, { force: true, restore: false });
				appendInfo(details(ctx, "Effort capabilities refreshed"));
				ctx.ui.notify("Effort capabilities refreshed", "info");
				return;
			}

			const option = parseEffort(raw, capabilities?.options ?? []);
			if (!option) {
				const available = capabilities?.options.map((candidate) => candidate.id).join(", ") || "none";
				const reason = `"${raw}" is not available for ${capabilities?.modelKey ?? "the active model"}. Available: ${available}.`;
				appendInfo(details(ctx, reason));
				ctx.ui.notify(reason, "warning");
				return;
			}
			applyOption(ctx, option, { persist: true, notify: true });
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		await synchronizeModel(ctx, { restore: true });
		initialized = true;
	});

	pi.on("model_select", async (_event, ctx) => {
		await synchronizeModel(ctx, { restore: true });
	});

	pi.on("thinking_level_select", async (event, ctx) => {
		if (!capabilities || !ctx.model || capabilities.modelKey !== modelKey(ctx.model)) return;
		if (pendingPiLevel) {
			if (event.level === pendingPiLevel) {
				pendingPiLevel = undefined;
				updateStatus(ctx);
				return;
			}
			pendingPiLevel = undefined;
		}

		const direct =
			capabilities.options.find((option) => option.id === event.level) ??
			capabilities.options.find((option) => option.piLevel === event.level);
		if (direct) {
			selectedId = direct.id;
			if (initialized) recordSelection(direct);
			updateStatus(ctx);
			return;
		}

		const fallback =
			capabilities.options.find((option) => option.id === capabilities?.defaultId) ?? capabilities.options[0];
		if (fallback) {
			applyOption(ctx, fallback, { persist: initialized, notify: false });
			ctx.ui.notify(`${effortLabel(event.level)} is not provided by this model; using ${fallback.label}.`, "warning");
		}
	});

}
