import { InteractiveMode, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * clear-command
 * -------------
 * Makes `/clear` work as "clear chat history and start a new session".
 *
 * pi 0.80.2 advertises `/clear` in its built-in command list (so it appears in
 * autocomplete) but never wires it to a handler — the interactive submit
 * handler only routes `/new` to `handleClearCommand`, so a typed `/clear` falls
 * through to the model. This routes `/clear` to pi's own `handleClearCommand`,
 * the same path `/new` uses.
 *
 * We do NOT `registerCommand("clear")`: that name collides with the advertised
 * built-in and pi emits an "[Extension issues] … conflicts with built-in
 * interactive command" diagnostic. Instead we wrap the editor's `onSubmit`
 * (the same seam pi itself dispatches commands from), so there is no conflict
 * and `/clear` still shows in autocomplete via pi's own built-in entry.
 *
 * Like the bundled `claude-queue-escape` extension this patches
 * `InteractiveMode.prototype`; everything is feature-detected and try/catch
 * wrapped, so a future pi that renames internals (or fixes `/clear` itself)
 * degrades gracefully instead of breaking startup.
 */

const MARK = "__leviClearWrapped";

function wrapEditorSubmit(editor: any, mode: any): void {
	const inner = editor?.onSubmit;
	if (typeof inner !== "function" || inner[MARK]) return;
	const wrapped = async (text: string) => {
		if (typeof text === "string" && text.trim() === "/clear") {
			try {
				mode.editor?.setText?.("");
			} catch {
				/* ignore */
			}
			await mode.handleClearCommand();
			return;
		}
		return inner(text);
	};
	(wrapped as any)[MARK] = true;
	editor.onSubmit = wrapped;
}

// Wrap both the default editor and the (possibly custom) active editor. Custom
// editors copy defaultEditor.onSubmit by reference, so once the default is
// wrapped, later custom editors inherit the wrapper; the MARK guard prevents
// double-wrapping.
function installClear(mode: any): void {
	try {
		if (!mode || typeof mode.handleClearCommand !== "function") return;
		if (mode.defaultEditor) wrapEditorSubmit(mode.defaultEditor, mode);
		if (mode.editor && mode.editor !== mode.defaultEditor) wrapEditorSubmit(mode.editor, mode);
	} catch {
		/* leave pi untouched on any feature-detection failure */
	}
}

const PATCH_SYM = Symbol.for("levi.pi.clear-command.patched");
const HOOK_METHODS = ["renderInitialMessages", "handleEvent"] as const;

function patchPrototype(): void {
	const proto: any = (InteractiveMode as any)?.prototype;
	if (!proto) return;

	const existing = proto[PATCH_SYM];
	if (existing) {
		existing.refCount += 1;
		return;
	}

	const originals: Record<string, any> = {};
	for (const name of HOOK_METHODS) {
		const orig = proto[name];
		if (typeof orig !== "function") continue;
		originals[name] = orig;
		proto[name] = function (this: any, ...args: any[]) {
			installClear(this);
			return orig.apply(this, args);
		};
	}
	proto[PATCH_SYM] = { originals, refCount: 1 };
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

export default function clearCommand(pi: ExtensionAPI): void {
	try {
		patchPrototype();
	} catch {
		/* never let a patch failure crash startup */
	}

	pi.on("session_shutdown", async () => {
		try {
			unpatchPrototype();
		} catch {
			/* ignore */
		}
	});
}

// Internal hooks for the offline test harness; inert at runtime (pi uses default).
export const __test__ = { installClear, wrapEditorSubmit, MARK };
