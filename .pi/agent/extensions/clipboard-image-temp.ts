import { randomUUID } from "node:crypto";
import { access, mkdir, writeFile } from "node:fs/promises";
import { constants as fsConstants, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

type ClipboardImage = {
	bytes: Uint8Array;
	mimeType: string;
};

type ClipboardImageModule = {
	readClipboardImage(options?: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform }): Promise<ClipboardImage | null>;
	extensionForImageMimeType(mimeType: string): string | null;
};

type SegmentMode = "word" | "grapheme";
type SegmentLike = { segment: string; index: number; input: string; isWordLike?: boolean };

const PASTE_MARKER_REGEX = /\[paste #(\d+)( (\+\d+ lines|\d+ chars))?\]/g;
const IMAGE_MARKER_REGEX = /\[Image #(\d+)\]/g;
const graphemeSegmenter = new (Intl as any).Segmenter(undefined, { granularity: "grapheme" });
const wordSegmenter = new (Intl as any).Segmenter(undefined, { granularity: "word" });

function candidateClipboardModulePaths(): string[] {
	const candidates: string[] = [];

	// Normal pi CLI launch: process.argv[1] is the pi bin symlink. Resolve it to
	// .../pi-coding-agent/dist/cli.js, then load a sibling util module.
	if (process.argv[1]) {
		try {
			const cliPath = realpathSync(process.argv[1]);
			candidates.push(join(dirname(cliPath), "utils", "clipboard-image.js"));
		} catch {
			// Ignore and try import.meta.resolve below.
		}
	}

	// Fallback for tests or embedded launchers where argv[1] is not the pi CLI.
	try {
		const resolve = (import.meta as any).resolve as ((specifier: string) => string) | undefined;
		const mainUrl = resolve?.("@earendil-works/pi-coding-agent");
		if (mainUrl) candidates.push(join(dirname(fileURLToPath(mainUrl)), "utils", "clipboard-image.js"));
	} catch {
		// Ignore; the caller reports a single useful load error.
	}

	return [...new Set(candidates)];
}

async function loadClipboardImageModule(): Promise<ClipboardImageModule> {
	const candidates = candidateClipboardModulePaths();
	for (const candidate of candidates) {
		if (!existsSync(candidate)) continue;
		return (await import(pathToFileURL(candidate).href)) as ClipboardImageModule;
	}
	throw new Error(`Could not find Pi clipboard image reader. Tried: ${candidates.join(", ") || "<none>"}`);
}

function configuredTempDir(): string {
	const override = process.env.PI_CLIPBOARD_IMAGE_TEMP_DIR?.trim();
	if (override) return override;

	// Pi's built-in image paste follows $TMPDIR via os.tmpdir(). On macOS that is
	// usually /var/folders/.../T. This extension intentionally uses the OS-level
	// temp root users expect to see in pasted paths.
	if (process.platform !== "win32") return "/tmp";
	return tmpdir();
}

async function writableTempDir(): Promise<string> {
	const candidates = [...new Set([configuredTempDir(), tmpdir()])];
	for (const candidate of candidates) {
		try {
			await mkdir(candidate, { recursive: true });
			await access(candidate, fsConstants.W_OK);
			return candidate;
		} catch {
			// Try the fallback.
		}
	}
	return tmpdir();
}

async function writeClipboardImageToTemp(clipboard: ClipboardImageModule): Promise<string | null> {
	const image = await clipboard.readClipboardImage();
	if (!image) return null;

	const dir = await writableTempDir();
	const ext = clipboard.extensionForImageMimeType(image.mimeType) ?? "png";
	const filePath = join(dir, `pi-clipboard-${randomUUID()}.${ext}`);
	await writeFile(filePath, Buffer.from(image.bytes));
	return filePath;
}

function markerForImage(id: number): string {
	return `[Image #${id}]`;
}

function validPasteIds(editor: any): Set<number> {
	const pastes = editor?.pastes;
	if (!pastes || typeof pastes.keys !== "function") return new Set();
	return new Set<number>(pastes.keys());
}

function findAtomicMarkerSpans(text: string, pasteIds: Set<number>, imageIds: Set<number>): Array<{ start: number; end: number }> {
	const spans: Array<{ start: number; end: number }> = [];

	for (const match of text.matchAll(PASTE_MARKER_REGEX)) {
		const id = Number.parseInt(match[1]!, 10);
		if (pasteIds.has(id)) spans.push({ start: match.index!, end: match.index! + match[0].length });
	}
	for (const match of text.matchAll(IMAGE_MARKER_REGEX)) {
		const id = Number.parseInt(match[1]!, 10);
		if (imageIds.has(id)) spans.push({ start: match.index!, end: match.index! + match[0].length });
	}

	return spans.sort((a, b) => a.start - b.start);
}

function segmentWithImageMarkers(text: string, mode: SegmentMode, pasteIds: Set<number>, imageIds: Set<number>): Iterable<SegmentLike> {
	if ((pasteIds.size === 0 || !text.includes("[paste #")) && (imageIds.size === 0 || !text.includes("[Image #"))) {
		return (mode === "word" ? wordSegmenter : graphemeSegmenter).segment(text);
	}

	const markers = findAtomicMarkerSpans(text, pasteIds, imageIds);
	if (markers.length === 0) return (mode === "word" ? wordSegmenter : graphemeSegmenter).segment(text);

	const baseSegments = (mode === "word" ? wordSegmenter : graphemeSegmenter).segment(text) as Iterable<SegmentLike>;
	const result: SegmentLike[] = [];
	let markerIndex = 0;

	for (const segment of baseSegments) {
		while (markerIndex < markers.length && markers[markerIndex]!.end <= segment.index) markerIndex++;
		const marker = markers[markerIndex];
		if (marker && segment.index >= marker.start && segment.index < marker.end) {
			if (segment.index === marker.start) {
				result.push({ segment: text.slice(marker.start, marker.end), index: marker.start, input: text });
			}
			continue;
		}
		result.push(segment);
	}

	return result;
}

function osc8(text: string, uri: string): string {
	return `\x1b]8;;${uri}\x1b\\${text}\x1b]8;;\x1b\\`;
}

class ClipboardImageEditor extends CustomEditor {
	private readonly clipboard: ClipboardImageModule;
	private readonly notify: (message: string, type?: "info" | "warning" | "error") => void;
	private imagePaths = new Map<number, string>();
	private imageCounter = 0;
	private pasteInFlight = false;

	constructor(tui: any, theme: any, keybindings: any, clipboard: ClipboardImageModule, notify: ClipboardImageEditor["notify"]) {
		super(tui, theme, keybindings);
		this.clipboard = clipboard;
		this.notify = notify;
		this.onPasteImage = () => {
			void this.pasteClipboardImage();
		};
	}

	private expandImageMarkers(text: string): string {
		let expanded = text;
		for (const [id, filePath] of this.imagePaths) {
			expanded = expanded.replaceAll(markerForImage(id), filePath);
		}
		return expanded;
	}

	private decorateImageMarkers(line: string): string {
		let decorated = line;
		for (const [id, filePath] of this.imagePaths) {
			const marker = markerForImage(id);
			const uri = pathToFileURL(filePath).href;
			decorated = decorated.replaceAll(marker, osc8(marker, uri));
		}
		return decorated;
	}

	private insertImageMarker(filePath: string): void {
		const editor = this as any;
		const id = ++this.imageCounter;
		this.imagePaths.set(id, filePath);

		const state = editor.state as { lines: string[]; cursorLine: number; cursorCol: number };
		const currentLine = state.lines[state.cursorLine] ?? "";
		const beforeCursor = state.cursorCol > 0 ? currentLine[state.cursorCol - 1] : "";
		const needsSpace = Boolean(beforeCursor && !/\s/.test(beforeCursor));
		const text = `${needsSpace ? " " : ""}${markerForImage(id)}`;

		editor.cancelAutocomplete?.();
		editor.pushUndoSnapshot?.();
		editor.lastAction = null;
		editor.exitHistoryBrowsing?.();
		editor.insertTextAtCursorInternal?.(text);
		this.tui.requestRender();
	}

	private async pasteClipboardImage(): Promise<void> {
		if (this.pasteInFlight) return;
		this.pasteInFlight = true;
		try {
			const filePath = await writeClipboardImageToTemp(this.clipboard);
			if (!filePath) return;
			this.insertImageMarker(filePath);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.notify(`Image paste failed: ${message}`, "warning");
		} finally {
			this.pasteInFlight = false;
		}
	}

	segment(text: string, mode: SegmentMode): Iterable<SegmentLike> {
		return segmentWithImageMarkers(text, mode, validPasteIds(this), new Set(this.imagePaths.keys()));
	}

	getExpandedText(): string {
		return this.expandImageMarkers(super.getExpandedText());
	}

	setText(text: string): void {
		super.setText(text);
		if (!text.includes("[Image #")) {
			this.imagePaths.clear();
			this.imageCounter = 0;
		}
	}

	submitValue(): void {
		const editor = this as any;
		editor.cancelAutocomplete?.();
		const raw = editor.state.lines.join("\n");
		const withTextPastes = editor.expandPasteMarkers ? editor.expandPasteMarkers(raw) : raw;
		const result = this.expandImageMarkers(withTextPastes).trim();

		editor.state = { lines: [""], cursorLine: 0, cursorCol: 0 };
		editor.pastes?.clear?.();
		editor.pasteCounter = 0;
		this.imagePaths.clear();
		this.imageCounter = 0;
		editor.exitHistoryBrowsing?.();
		editor.scrollOffset = 0;
		editor.undoStack?.clear?.();
		editor.lastAction = null;
		editor.onChange?.("");
		editor.onSubmit?.(result);
	}

	render(width: number): string[] {
		return super.render(width).map((line) => this.decorateImageMarkers(line));
	}
}

export default async function clipboardImageTempExtension(pi: ExtensionAPI) {
	let clipboard: ClipboardImageModule | undefined;
	let clipboardLoadError: string | undefined;

	try {
		clipboard = await loadClipboardImageModule();
	} catch (error) {
		clipboardLoadError = error instanceof Error ? error.message : String(error);
	}

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		if (!clipboard) {
			ctx.ui.notify(`Clipboard image temp extension disabled: ${clipboardLoadError ?? "could not load Pi clipboard image reader"}`, "warning");
			return;
		}

		ctx.ui.setEditorComponent((tui, theme, keybindings) =>
			new ClipboardImageEditor(tui, theme, keybindings, clipboard!, (message, type) => ctx.ui.notify(message, type)),
		);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		ctx.ui.setStatus("clipboard-image-temp", undefined);
	});
}
