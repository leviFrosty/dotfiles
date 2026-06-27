import { CustomEditor, InteractiveMode, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Claude Code-style queue handling:
// - Esc cancels the active run but leaves queued steering/follow-up messages intact,
//   so pi continues with the queued message instead of restoring it into the editor.
// - Up restores queued messages into the prompt for editing before normal history navigation.

type RestoreOptions = { abort?: boolean; currentText?: string } | undefined;
type RestoreQueuedMessages = (this: unknown, options?: RestoreOptions) => number;
type QueueSnapshot = { steering?: readonly string[]; followUp?: readonly string[] };
type EditorInternals = {
	getText?: () => string;
	isEditorEmpty?: () => boolean;
	isOnFirstVisualLine?: () => boolean;
	isShowingAutocomplete?: () => boolean;
	keybindings?: { matches?: (data: string, action: string) => boolean };
	historyIndex?: number;
	state?: { cursorCol?: number };
};

type InteractiveModeInternals = {
	agent?: { abort?: () => void };
	ui?: { requestRender?: () => void };
	editor?: EditorInternals;
	defaultEditor?: EditorInternals;
	getAllQueuedMessages?: () => QueueSnapshot;
	updatePendingMessagesDisplay?: () => void;
	restoreQueuedMessagesToEditor?: RestoreQueuedMessages;
};

type HandleInput = (this: EditorInternals, data: string) => void;
type UpdatePendingMessagesDisplay = (this: InteractiveModeInternals) => void;

type PatchState = {
	original: RestoreQueuedMessages;
	originalHandleInput: HandleInput;
	originalUpdatePendingMessagesDisplay: UpdatePendingMessagesDisplay | undefined;
	refCount: number;
};

const PATCH_KEY = Symbol.for("levi.pi.claude-queue-escape.patch");

type GlobalWithPatch = typeof globalThis & Record<symbol, PatchState | undefined>;

function getPatchState(): PatchState | undefined {
	return (globalThis as GlobalWithPatch)[PATCH_KEY];
}

function setPatchState(state: PatchState | undefined): void {
	(globalThis as GlobalWithPatch)[PATCH_KEY] = state;
}

const editorModes = new WeakMap<EditorInternals, InteractiveModeInternals>();

function rememberMode(mode: InteractiveModeInternals): void {
	if (mode.editor) editorModes.set(mode.editor, mode);
	if (mode.defaultEditor) editorModes.set(mode.defaultEditor, mode);
}

function queuedCount(mode: InteractiveModeInternals): number {
	const queued = mode.getAllQueuedMessages?.();
	return (queued?.steering?.length ?? 0) + (queued?.followUp?.length ?? 0);
}

function isHistoryUp(editor: EditorInternals, data: string): boolean {
	return editor.keybindings?.matches?.(data, "tui.editor.cursorUp") === true;
}

function wouldNavigateHistory(editor: EditorInternals): boolean {
	if (editor.isShowingAutocomplete?.()) return false;
	if (!editor.isOnFirstVisualLine?.()) return false;

	return editor.isEditorEmpty?.() === true || (editor.historyIndex ?? -1) > -1 || editor.state?.cursorCol === 0;
}

function restoreQueuedForEdit(editor: EditorInternals, data: string): boolean {
	if (!isHistoryUp(editor, data) || !wouldNavigateHistory(editor)) return false;

	const mode = editorModes.get(editor);
	if (!mode || queuedCount(mode) === 0) return false;

	const restored = mode.restoreQueuedMessagesToEditor?.() ?? 0;
	if (restored <= 0) return false;

	mode.ui?.requestRender?.();
	return true;
}

function patchInteractiveAbort(): void {
	const proto = InteractiveMode.prototype as unknown as InteractiveModeInternals;
	const existing = getPatchState();
	if (existing) {
		existing.refCount += 1;
		return;
	}

	const original = proto.restoreQueuedMessagesToEditor;
	if (!original) return;

	const originalUpdatePendingMessagesDisplay = proto.updatePendingMessagesDisplay;
	if (originalUpdatePendingMessagesDisplay) {
		proto.updatePendingMessagesDisplay = function patchedUpdatePendingMessagesDisplay(this: InteractiveModeInternals): void {
			rememberMode(this);
			return originalUpdatePendingMessagesDisplay.call(this);
		};
	}

	const editorProto = CustomEditor.prototype as unknown as { handleInput: HandleInput };
	const originalHandleInput = editorProto.handleInput;
	editorProto.handleInput = function patchedHandleInput(this: EditorInternals, data: string): void {
		if (restoreQueuedForEdit(this, data)) return;
		return originalHandleInput.call(this, data);
	};

	proto.restoreQueuedMessagesToEditor = function patchedRestoreQueuedMessagesToEditor(
		this: InteractiveModeInternals,
		options?: RestoreOptions,
	): number {
		rememberMode(this);

		if (options?.abort) {
			const count = queuedCount(this);
			this.agent?.abort?.();
			this.updatePendingMessagesDisplay?.();
			this.ui?.requestRender?.();
			return count;
		}

		return original.call(this, options);
	};

	setPatchState({ original, originalHandleInput, originalUpdatePendingMessagesDisplay, refCount: 1 });
}

function unpatchInteractiveAbort(): void {
	const state = getPatchState();
	if (!state) return;

	state.refCount -= 1;
	if (state.refCount > 0) return;

	const proto = InteractiveMode.prototype as unknown as InteractiveModeInternals;
	proto.restoreQueuedMessagesToEditor = state.original;
	proto.updatePendingMessagesDisplay = state.originalUpdatePendingMessagesDisplay;

	const editorProto = CustomEditor.prototype as unknown as { handleInput: HandleInput };
	editorProto.handleInput = state.originalHandleInput;

	setPatchState(undefined);
}

export default function claudeQueueEscape(pi: ExtensionAPI) {
	patchInteractiveAbort();

	pi.on("session_shutdown", async () => {
		unpatchInteractiveAbort();
	});
}
