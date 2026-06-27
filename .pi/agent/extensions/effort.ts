import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { Container, Key, Text, matchesKey, truncateToWidth, type AutocompleteItem } from "@earendil-works/pi-tui";

const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const satisfies readonly ModelThinkingLevel[];
type EffortLevel = (typeof LEVELS)[number];

const ALIASES: Record<EffortLevel, readonly string[]> = {
	off: ["off", "none", "no", "disable", "disabled", "0"],
	minimal: ["minimal", "min", "minimum"],
	low: ["low"],
	medium: ["medium", "med", "mid"],
	high: ["high"],
	xhigh: ["xhigh", "x-high", "x_high", "extra-high", "extra_high", "xhi", "x-hi", "max", "maximum"],
};

function normalize(input: string): string {
	return input.trim().toLowerCase().replace(/^--?/, "");
}

function parseEffort(input: string): EffortLevel | undefined {
	const normalized = normalize(input);
	if (!normalized) return undefined;
	for (const level of LEVELS) {
		if (ALIASES[level].includes(normalized)) return level;
	}
	return undefined;
}

function levelLabel(level: EffortLevel, _ctx?: ExtensionContext): string {
	return level;
}

function modelName(ctx: ExtensionContext): string {
	return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "(no model selected)";
}

function availableLevels(ctx: ExtensionContext): EffortLevel[] {
	if (!ctx.model) return [...LEVELS];
	return getSupportedThinkingLevels(ctx.model) as EffortLevel[];
}

function mappingDetails(ctx: ExtensionContext): string {
	const model = ctx.model;
	if (!model?.thinkingLevelMap || Object.keys(model.thinkingLevelMap).length === 0) {
		return "No model-specific effort map. Defaults apply: reasoning models support off/minimal/low/medium/high; the top xhigh tier only appears when explicitly mapped by the model.";
	}

	const entries = LEVELS.map((level) => {
		const mapped = model.thinkingLevelMap?.[level];
		if (mapped === null) return `${level}: unsupported`;
		if (typeof mapped === "string") return `${level}: provider value "${mapped}"`;
		return `${level}: default`;
	});
	return `Model effort map: ${entries.join(", ")}.`;
}

function effortDetails(ctx: ExtensionContext, reason?: string): string {
	const model = ctx.model;
	const current = piSafeCurrentLevel(ctx);
	const supported = availableLevels(ctx);
	const reasoning = model?.reasoning ? "yes" : "no";
	const aliases = LEVELS.map((level) => `${level} (${ALIASES[level].join("|")})`).join(", ");

	return [
		reason ? `Effort unchanged: ${reason}` : "Effort capabilities",
		`Model: ${modelName(ctx)}`,
		`Reasoning/effort capable: ${reasoning}`,
		`Current effort: ${levelLabel(current, ctx)}`,
		`Available for this model: ${supported.map((level) => levelLabel(level, ctx)).join(", ")}`,
		mappingDetails(ctx),
		`Accepted exact aliases: ${aliases}`,
	].join("\n");
}

let getCurrentLevel: (() => EffortLevel) | undefined;
function piSafeCurrentLevel(_ctx: ExtensionContext): EffortLevel {
	return (getCurrentLevel?.() ?? "off") as EffortLevel;
}

function sendEffortMessage(pi: ExtensionAPI, content: string) {
	pi.sendMessage({
		customType: "effort",
		content,
		display: true,
	});
}

function updateStatus(ctx: ExtensionContext, level: EffortLevel) {
	const thinkingColor = ctx.ui.theme.getThinkingBorderColor(level);
	ctx.ui.setStatus("effort", thinkingColor(levelLabel(level, ctx)));
}

async function setEffort(pi: ExtensionAPI, ctx: ExtensionContext, requested: EffortLevel): Promise<boolean> {
	const supported = availableLevels(ctx);
	if (!supported.includes(requested)) {
		const reason = `"${levelLabel(requested, ctx)}" is not available for ${modelName(ctx)}.`;
		sendEffortMessage(pi, effortDetails(ctx, reason));
		ctx.ui.notify(reason, "warning");
		return false;
	}

	const previous = pi.getThinkingLevel() as EffortLevel;
	pi.setThinkingLevel(requested);
	const effective = pi.getThinkingLevel() as EffortLevel;
	updateStatus(ctx, effective);

	if (effective !== requested) {
		const reason = `requested "${levelLabel(requested, ctx)}" but pi clamped it to "${levelLabel(effective, ctx)}" for ${modelName(ctx)}.`;
		sendEffortMessage(pi, effortDetails(ctx, reason));
		ctx.ui.notify(`Effort clamped to ${levelLabel(effective, ctx)}`, "warning");
		return false;
	}

	ctx.ui.notify(
		previous === effective ? `Effort already ${levelLabel(effective, ctx)}` : `Effort set to ${levelLabel(effective, ctx)}`,
		"info",
	);
	return true;
}

async function showEffortSlider(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	if (ctx.mode !== "tui") {
		sendEffortMessage(pi, effortDetails(ctx, "/effort without an argument requires TUI mode for the interactive slider."));
		return;
	}

	const supported = availableLevels(ctx);
	let selectedIndex = Math.max(0, supported.indexOf(pi.getThinkingLevel() as EffortLevel));

	const result = await ctx.ui.custom<EffortLevel | null>((tui, theme, _kb, done) => {
		const renderSlider = (width: number): string[] => {
			const container = new Container();
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			container.addChild(new Text(theme.fg("accent", theme.bold("Effort Level")), 1, 0));
			container.addChild(new Text(theme.fg("muted", modelName(ctx)), 1, 0));

			const chunks = supported.map((level, index) => {
				const display = levelLabel(level, ctx);
				const label = index === selectedIndex ? `[${display}]` : ` ${display} `;
				return index === selectedIndex ? theme.fg("accent", theme.bold(label)) : theme.fg("muted", label);
			});
			container.addChild(new Text(chunks.join(theme.fg("dim", " ─ ")), 1, 1));
			container.addChild(new Text(theme.fg("dim", "←/→ or ↑/↓ change • enter apply • esc cancel"), 1, 0));
			container.addChild(
				new Text(theme.fg("dim", `Available: ${supported.map((level) => levelLabel(level, ctx)).join(", ")}`), 1, 0),
			);
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			return container.render(width).map((line) => truncateToWidth(line, width));
		};

		return {
			render(width: number) {
				return renderSlider(width);
			},
			invalidate() {},
			handleInput(data: string) {
				if (matchesKey(data, Key.right) || matchesKey(data, Key.down)) {
					selectedIndex = (selectedIndex + 1) % supported.length;
					tui.requestRender();
					return;
				}
				if (matchesKey(data, Key.left) || matchesKey(data, Key.up)) {
					selectedIndex = (selectedIndex - 1 + supported.length) % supported.length;
					tui.requestRender();
					return;
				}
				if (matchesKey(data, Key.enter)) {
					done(supported[selectedIndex] ?? null);
					return;
				}
				if (matchesKey(data, Key.escape)) {
					done(null);
				}
			},
		};
	});

	if (result) {
		await setEffort(pi, ctx, result);
	}
}

export default function effortExtension(pi: ExtensionAPI) {
	getCurrentLevel = () => pi.getThinkingLevel() as EffortLevel;

	pi.registerMessageRenderer("effort", (message, _options, theme) => {
		return new Text(theme.fg("customMessageLabel", "effort") + "\n" + message.content, 1, 0);
	});

	pi.registerCommand("effort", {
		description: "Set effort level (interactive slider or /effort low|high|max)",
		getArgumentCompletions(prefix: string): AutocompleteItem[] | null {
			const p = normalize(prefix);
			const items: AutocompleteItem[] = LEVELS.flatMap((level) =>
				ALIASES[level].map((alias) => ({
					value: alias,
					label: alias,
					description: `Set effort to ${levelLabel(level)}`,
				})),
			).filter((item) => item.value.startsWith(p));
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			const raw = (args ?? "").trim();
			if (!raw) {
				await showEffortSlider(pi, ctx);
				return;
			}

			const requested = parseEffort(raw);
			if (!requested) {
				const reason = `"${raw}" is not an exact supported effort alias.`;
				sendEffortMessage(pi, effortDetails(ctx, reason));
				ctx.ui.notify(reason, "warning");
				return;
			}

			await setEffort(pi, ctx, requested);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		updateStatus(ctx, pi.getThinkingLevel() as EffortLevel);
	});

	pi.on("thinking_level_select", async (event, ctx) => {
		updateStatus(ctx, event.level as EffortLevel);
	});

	pi.on("model_select", async (_event, ctx) => {
		updateStatus(ctx, pi.getThinkingLevel() as EffortLevel);
	});
}
