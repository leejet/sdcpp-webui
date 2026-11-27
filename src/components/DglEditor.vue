<script setup lang="ts">
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { Compartment, countColumn, EditorState, StateEffect, StateField, type Text } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, keymap, lineNumbers } from "@codemirror/view";
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { createAviPreview } from "../lib/avi-preview";
import { fetchServerMedia, mediaViewUrl, readServerApiKey } from "../lib/api";
import { connectNativePlayback, createExpandButton, createPlaybackPicture } from "../lib/media-preview";
import type { MediaOutput } from "../lib/types";

const props = defineProps<{
    modelValue: string;
    documentRevision: number;
    readOnly: boolean;
    mediaView: boolean;
    mediaOutput?: MediaOutput;
    outputRevision: number;
}>();
const emit = defineEmits<{
    (event: "update:modelValue", value: string): void;
    (event: "save" | "save-as" | "run"): void;
    (event: "expand-image", src: string, alt: string): void;
}>();

type MediaKind = "image" | "video" | "avi";
type MediaPath = { root: string; path: string; label: string; kind: MediaKind };
type MediaPreview = { path: string; url: string; kind: MediaKind; output: boolean };
type ExpandedVideo = { kind: "video" | "avi"; url: string; path: string; position: number };
type RenderedMedia = { load(preflight?: Response): void; destroy(): void };
type MediaOptions = { enabled: boolean; output?: MediaOutput; outputRevision: number };
type PreviewSize = { width: number; height: number };

const host = ref<HTMLElement>();
const videoDialog = ref<HTMLDialogElement>();
const expandedHost = ref<HTMLElement>();
const expandedVideo = ref<ExpandedVideo>();
const playbackError = ref(false);
const readOnly = new Compartment();
const setMediaOptions = StateEffect.define<MediaOptions>();
const pendingMedia = new WeakMap<HTMLElement, IntersectionObserver>();
const renderedMedia = new WeakMap<HTMLElement, RenderedMedia[]>();
const tabSize = 4;
let view: EditorView | undefined;

function openVideo(kind: ExpandedVideo["kind"], file: MediaPreview, position: number): void {
    expandedVideo.value = { kind, url: file.url, path: file.path, position };
    playbackError.value = false;
    void nextTick(() => {
        const dialog = videoDialog.value;
        if (dialog && !dialog.open) dialog.showModal();
    });
}

function clearExpandedVideo(): void {
    expandedVideo.value = undefined;
}

watch(expandedHost, (host, _, onCleanup) => {
    const file = expandedVideo.value;
    if (!host || !file) return;
    const unavailable = () => { playbackError.value = true; };
    const player = file.kind === "avi"
        ? createAviPreview(host, file.url, file.path, unavailable, { initialFrame: file.position })
        : createNativeVideo(host, file, unavailable);
    onCleanup(player.destroy);
    player.load();
});

function outputRelativePath(value: string, output?: MediaOutput): string | undefined {
    for (const directory of output?.paths ?? ["output"]) {
        if (directory === ".") {
            if (!value.startsWith("/") && !/^[a-z]:/i.test(value)) return value;
            continue;
        }
        const prefix = directory.endsWith("/") ? directory : directory + "/";
        const start = value.slice(0, prefix.length);
        if (output?.case_insensitive ? start.toLowerCase() === prefix.toLowerCase() : start === prefix) {
            return value.slice(prefix.length);
        }
    }
}

function parseMediaPath(literal: string, output?: MediaOutput): MediaPath | undefined {
    let value: string;
    try {
        value = JSON.parse(literal);
    } catch {
        return;
    }
    const label = value.replace(/\\/g, "/").replace(/^(?:\.\/)+/, "");
    let root = "output";
    let path = outputRelativePath(label, output);
    if (path === undefined) {
        const match = /^(input|assets)\/(.+)$/.exec(label);
        if (!match) return;
        [, root, path] = match;
    }
    if (path.split("/").some((part) => !part || /[. ]$/.test(part) || /[:*?"<>|\x00-\x1f\x7f]/.test(part))) return;
    if (/\.avi$/i.test(path)) return { root, path, label, kind: "avi" };
    if (/\.(mp4|webm)$/i.test(path)) return { root, path, label, kind: "video" };
    if (/\.(png|jpe?g|gif|webp)$/i.test(path)) return { root, path, label, kind: "image" };
}

class MediaWidget extends WidgetType {
    private readonly sizes: (PreviewSize | undefined)[] = [];

    constructor(readonly files: readonly MediaPreview[], readonly indent: number) {
        super();
    }

    get estimatedHeight(): number {
        let height = 0;
        this.files.forEach((file, index) => {
            if (!file.output) height = Math.max(height, this.sizes[index]?.height ?? 104);
        });
        return height ? height + 10 : 0;
    }

    eq(other: MediaWidget): boolean {
        return this.indent === other.indent && this.files.length === other.files.length &&
            this.files.every((file, index) => file.url === other.files[index].url);
    }

    toDOM(editor: EditorView): HTMLElement {
        const document = editor.dom.ownerDocument;
        const block = document.createElement("div");
        block.className = "dgl-media-block";
        block.classList.toggle("dgl-media-empty", this.files.every((file) => file.output));
        block.style.setProperty("--dgl-media-indent", this.indent + "ch");
        const elements = this.files.map((file, index): RenderedMedia => {
            const card = block.appendChild(document.createElement("figure"));
            card.title = file.path;
            card.hidden = file.output;
            card.setAttribute("aria-label", "Media view");
            function unavailable(): void {
                card.classList.add("dgl-media-unavailable");
                const message = card.appendChild(document.createElement("p"));
                message.setAttribute("role", "status");
                message.textContent = message.title = "Cannot view this media file.";
                editor.requestMeasure();
            }
            const media = file.kind === "avi"
                ? createAviPreview(card, file.url, file.path, unavailable, { onExpand: (frame) => openVideo("avi", file, frame) })
                : file.kind === "video" ? createNativeVideo(card, file, unavailable, (position) => openVideo("video", file, position))
                    : createImagePreview(card, file, unavailable);
            const lifetime = new AbortController();
            addPreviewResizeHandle(editor, block, card, file.path, this.sizes[index], (size) => { this.sizes[index] = size; }, lifetime.signal);
            return {
                async load() {
                    if (!file.output) return media.load();
                    const response = await fetchServerMedia(file.url, { method: "HEAD", signal: lifetime.signal }).catch(() => undefined);
                    if (lifetime.signal.aborted || response?.status === 404) return;

                    card.hidden = false;
                    block.classList.remove("dgl-media-empty");
                    if (response?.ok) {
                        media.load(response);
                        editor.requestMeasure();
                    } else {
                        unavailable();
                    }
                },
                destroy() {
                    lifetime.abort();
                    media.destroy();
                },
            };
        });
        renderedMedia.set(block, elements);

        const visible = new IntersectionObserver((entries) => {
            if (pendingMedia.get(block) !== visible || !entries.some((entry) => entry.isIntersecting)) return;
            visible.disconnect();
            pendingMedia.delete(block);
            elements.forEach((media) => media.load());
        }, { root: editor.scrollDOM, rootMargin: "144px 0px" });
        pendingMedia.set(block, visible);
        visible.observe(block);
        return block;
    }

    destroy(block: HTMLElement): void {
        pendingMedia.get(block)?.disconnect();
        pendingMedia.delete(block);
        renderedMedia.get(block)?.forEach((media) => media.destroy());
        renderedMedia.delete(block);
    }
}

function addPreviewResizeHandle(editor: EditorView, block: HTMLElement, card: HTMLElement, path: string,
                                initial: PreviewSize | undefined, saveSize: (size?: PreviewSize) => void, signal: AbortSignal): void {
    const handle = card.appendChild(card.ownerDocument.createElement("button"));
    handle.type = "button";
    handle.className = "dgl-preview-resize";
    handle.setAttribute("aria-label", "Resize preview for " + path);
    handle.title = "Drag to resize. Double-click to reset.";

    function applySize(size?: PreviewSize): void {
        card.classList.toggle("dgl-media-resized", size !== undefined);
        card.style.width = size ? `${size.width}px` : "";
        card.style.height = size ? `${size.height}px` : "";
    }

    function resize(width: number, height: number): void {
        const style = getComputedStyle(block);
        const maxWidth = Math.max(1, block.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight));
        const maxHeight = Math.max(80, Math.min(760, editor.scrollDOM.clientHeight - 28));
        const size = { width: Math.min(maxWidth, Math.max(96, width)), height: Math.min(maxHeight, Math.max(80, height)) };
        applySize(size);
        saveSize(size);
        editor.requestMeasure();
    }

    function reset(): void {
        applySize();
        saveSize();
        editor.requestMeasure();
    }

    let stopDrag: (() => void) | undefined;
    handle.addEventListener("pointerdown", (event) => {
        if (event.button !== 0 || stopDrag) return;
        event.preventDefault();
        const { pointerId, clientX, clientY } = event;
        const { width, height } = card.getBoundingClientRect();
        const drag = new AbortController();
        const listen = { capture: true, signal: drag.signal };
        const document = card.ownerDocument;
        stopDrag = () => {
            drag.abort();
            stopDrag = undefined;
            if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
        };
        handle.setPointerCapture(pointerId);
        document.addEventListener("pointermove", (move) => {
            if (move.pointerId === pointerId) resize(width + move.clientX - clientX, height + move.clientY - clientY);
        }, listen);
        function finish(end: PointerEvent): void {
            if (end.pointerId === pointerId) stopDrag?.();
        }
        document.addEventListener("pointerup", finish, listen);
        document.addEventListener("pointercancel", finish, listen);
        document.defaultView?.addEventListener("blur", stopDrag, listen);
    });
    signal.addEventListener("abort", () => stopDrag?.(), { once: true });
    handle.addEventListener("dblclick", reset);
    handle.addEventListener("keydown", (event) => {
        const directions: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
        const direction = directions[event.key];
        if (!direction && event.key !== "Home") return;
        event.preventDefault();
        if (!direction) { reset(); return; }
        const { width, height } = card.getBoundingClientRect();
        resize(width + direction[0] * 16, height + direction[1] * 16);
    });
    applySize(initial);
}

function connectMediaSource(media: HTMLImageElement | HTMLVideoElement, url: string, unavailable: () => void): RenderedMedia {
    const abort = new AbortController();
    let mediaUrl = "";
    media.addEventListener("error", unavailable, { once: true, signal: abort.signal });
    return {
        async load() {
            if (!readServerApiKey("")) {
                media.src = url;
                return;
            }
            try {
                const response = await fetchServerMedia(url, { signal: abort.signal });
                if (!response.ok) throw new Error("Cannot load media");
                const blob = await response.blob();
                if (abort.signal.aborted) return;
                mediaUrl = URL.createObjectURL(blob);
                media.src = mediaUrl;
            } catch {
                if (!abort.signal.aborted) unavailable();
            }
        },
        destroy() {
            abort.abort();
            media.removeAttribute("src");
            if (mediaUrl) URL.revokeObjectURL(mediaUrl);
        },
    };
}

function createImagePreview(card: HTMLElement, file: MediaPreview, unavailable: () => void): RenderedMedia {
    const image = card.ownerDocument.createElement("img");
    image.alt = file.path;
    image.decoding = "async";
    const expand = createExpandButton(image, "Expand image " + file.path, () => emit("expand-image", image.src, file.path));
    image.addEventListener("load", () => { expand.disabled = false; }, { once: true });
    card.appendChild(expand);
    return connectMediaSource(image, file.url, unavailable);
}

function createNativeVideo(card: HTMLElement, file: { url: string; path: string; position?: number }, unavailable: () => void,
                           onExpand?: (position: number) => void): RenderedMedia {
    const document = card.ownerDocument;
    const player = card.appendChild(document.createElement("div"));
    player.className = "dgl-preview-player";
    const video = document.createElement("video");
    video.preload = "metadata";
    video.playsInline = true;
    const picture = player.appendChild(onExpand
        ? createExpandButton(video, "Expand video " + file.path, () => {
            video.pause();
            onExpand(video.currentTime);
        })
        : createPlaybackPicture(video));
    const disconnect = connectNativePlayback(player, video, onExpand ? { expand: picture } : { picture }, file.position);
    const media = connectMediaSource(video, file.url, unavailable);
    return {
        load: media.load,
        destroy() {
            disconnect();
            video.pause();
            media.destroy();
            video.load();
        },
    };
}

function scanSource(doc: Text, options: MediaOptions) {
    const marks = [];
    const rows = new Map<number, { files: MediaPreview[]; indent: number }>();
    const pattern = /(?<comment>#[^\r\n]*|\/\/[^\r\n]*)|(?<string>"(?:\\[^\r\n]|[^"\\\r\n])*"?)|(?<keyword>\b(?:fn|return|true|false)\b)|(?<number>-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|(?<call>\b[a-zA-Z_]\w*(?:::[a-zA-Z_]\w*)*(?=\s*\())|\b[a-zA-Z_]\w*/g;
    for (const match of doc.toString().matchAll(pattern)) {
        const from = match.index ?? 0;
        const to = from + match[0].length;
        const kind = Object.keys(match.groups ?? {}).find((key) => match.groups?.[key] !== undefined);
        if (!kind) continue;
        marks.push(Decoration.mark({ class: "dgl-token-" + kind }).range(from, to));
        if (!options.enabled || kind !== "string") continue;
        const file = parseMediaPath(match[0], options.output);
        if (!file) continue;

        marks.push(Decoration.mark({ class: "dgl-media-path" }).range(from + 1, to - 1));
        const line = doc.lineAt(from);
        let row = rows.get(line.to);
        if (!row) {
            const prefix = /^[ \t]*/.exec(line.text)?.[0] ?? "";
            row = { files: [], indent: countColumn(prefix, tabSize) };
            rows.set(line.to, row);
        }
        row.files.push({
            path: file.label,
            kind: file.kind,
            output: file.root === "output",
            url: mediaViewUrl(file.root, file.path, file.root === "output" ? options.outputRevision : 0),
        });
    }
    for (const [at, { files, indent }] of rows) {
        marks.push(Decoration.widget({ widget: new MediaWidget(files, indent), side: 1, block: true }).range(at));
    }
    return { options, decorations: Decoration.set(marks, true) };
}

function mediaOptions(): MediaOptions {
    return { enabled: props.mediaView, output: props.mediaOutput, outputRevision: props.outputRevision };
}

const sourceMarkup = StateField.define({
    create: (state) => scanSource(state.doc, mediaOptions()),
    update(previous, transaction) {
        const effect = transaction.effects.find((value) => value.is(setMediaOptions));
        const options = effect?.value ?? previous.options;
        return transaction.docChanged || options !== previous.options ? scanSource(transaction.newDoc, options) : previous;
    },
    provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
});

function editorState(doc: string): EditorState {
    return EditorState.create({
        doc,
        extensions: [
            lineNumbers(),
            history(),
            EditorState.tabSize.of(tabSize),
            readOnly.of(EditorState.readOnly.of(props.readOnly)),
            EditorView.contentAttributes.of({ "aria-label": "DGL source", spellcheck: "false", autocapitalize: "off", autocomplete: "off" }),
            sourceMarkup,
            keymap.of([
                { key: "Mod-Enter", run: () => { emit("run"); return true; }, stopPropagation: true },
                { key: "Mod-Shift-s", run: () => { emit("save-as"); return true; }, stopPropagation: true },
                { key: "Mod-s", run: () => { emit("save"); return true; }, stopPropagation: true },
                ...defaultKeymap,
                ...historyKeymap,
            ]),
            EditorView.updateListener.of((update) => {
                if (update.docChanged) emit("update:modelValue", update.state.doc.toString());
            }),
        ],
    });
}

watch([() => props.documentRevision, () => props.modelValue], ([revision, text], [previousRevision]) => {
    if (!view || (revision === previousRevision && view.state.doc.toString() === text.replace(/\r\n?/g, "\n"))) return;
    view.setState(editorState(text));
    view.scrollDOM.scrollTop = 0;
    view.scrollDOM.scrollLeft = 0;
});
watch(() => props.readOnly, (value) => {
    view?.dispatch({ effects: readOnly.reconfigure(EditorState.readOnly.of(value)) });
});
watch([() => props.mediaView, () => props.mediaOutput, () => props.outputRevision], () => {
    view?.dispatch({ effects: setMediaOptions.of(mediaOptions()) });
    if (!props.mediaView) videoDialog.value?.close();
});

onMounted(() => {
    view = new EditorView({ state: editorState(props.modelValue), parent: host.value });
});
onBeforeUnmount(() => {
    clearExpandedVideo();
    view?.destroy();
});
defineExpose({ focus: () => view?.focus() });
</script>

<template>
    <div ref="host" class="dgl-code"></div>
    <dialog v-if="expandedVideo" ref="videoDialog" class="lightbox dgl-video-dialog"
        :aria-label="'Expanded video ' + expandedVideo.path" @click.self="videoDialog?.close()" @close="clearExpandedVideo">
        <button class="lightbox__close" type="button" autofocus @click="videoDialog?.close()">Close</button>
        <p v-if="playbackError" role="status">Cannot play this video.</p>
        <div v-else ref="expandedHost" class="dgl-expanded-host"></div>
    </dialog>
</template>

<style scoped>
.dgl-code {
    --code-comment: #64748b;
    --code-keyword: #7439a6;
    --code-string: #086c61;
    --code-number: #a13e24;
    --code-call: #2151a3;
    margin-top: 12px;
    height: clamp(380px, 67dvh, 1000px);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--input-bg);
    overflow: hidden;
}
:global([data-theme="dark"]) .dgl-code {
    --code-comment: #9ca3af;
    --code-keyword: #c4a5f6;
    --code-string: #89d6b7;
    --code-number: #f2aa84;
    --code-call: #9bbdff;
}
.dgl-code:focus-within { border-color: var(--focus-border); }
.dgl-code :deep(.cm-editor) { height: 100%; font: 13px/21px var(--font-mono); }
.dgl-code :deep(.cm-editor.cm-focused) { outline: none; }
.dgl-code :deep(.cm-scroller) { font: inherit; }
.dgl-code :deep(.cm-content) { padding: 12px 0; font-variant-ligatures: none; }
.dgl-code :deep(.cm-line) { padding-inline: 12px; }
.dgl-code :deep(.cm-gutters) { color: var(--muted); background: var(--panel-subtle); border-color: var(--border); }
.dgl-code :deep(.cm-lineNumbers .cm-gutterElement) { padding-inline: 8px; }
.dgl-code :deep(.dgl-token-comment) { color: var(--code-comment); }
.dgl-code :deep(.dgl-token-keyword) { color: var(--code-keyword); }
.dgl-code :deep(.dgl-token-string) { color: var(--code-string); }
.dgl-code :deep(.dgl-token-number) { color: var(--code-number); }
.dgl-code :deep(.dgl-token-call) { color: var(--code-call); }
.dgl-code :deep(.dgl-media-path) {
    text-decoration: underline dotted;
    text-decoration-thickness: 1px;
    text-underline-offset: 3px;
}
.dgl-code :deep(.dgl-media-block) {
    box-sizing: border-box;
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    gap: 6px 8px;
    padding: 2px 12px 8px;
    padding-inline-start: calc(12px + min(var(--dgl-media-indent), 25%));
}
.dgl-code :deep(.dgl-media-block.dgl-media-empty) { padding: 0; }
.dgl-code :deep(.dgl-media-block figure) {
    position: relative;
    display: flex;
    align-items: flex-start;
    box-sizing: border-box;
    margin: 0;
    min-width: min(100%, 72px);
    max-width: min(100%, 210px);
    height: 104px;
    border-inline-start: 1px solid var(--border);
    padding-inline-start: 7px;
    padding-inline-end: 16px;
}
.dgl-code :deep(.dgl-media-block .dgl-media-resized) { max-width: 100%; max-height: min(67dvh, 760px); }
.dgl-code :deep(.dgl-preview-resize) {
    position: absolute;
    inset: auto 0 0 auto;
    width: 16px;
    height: 22px;
    padding: 0;
    border: 0;
    color: var(--muted);
    background: transparent;
    cursor: nwse-resize;
    touch-action: none;
}
.dgl-code :deep(.dgl-preview-resize::after) {
    content: "";
    position: absolute;
    right: 2px;
    bottom: 3px;
    width: 10px;
    height: 10px;
    background: linear-gradient(135deg, transparent 50%, currentColor 50% 60%, transparent 60% 75%, currentColor 75% 85%, transparent 85%);
}
.dgl-code :deep(.dgl-preview-resize:is(:hover, :focus-visible, :active)) { color: var(--primary); }
.dgl-code :deep(.dgl-media-block :is(img, video)) {
    max-width: 100%;
    max-height: 100%;
    border-radius: var(--radius-sm);
}
.dgl-code :deep(.dgl-media-expand) {
    display: block;
    max-width: 100%;
    max-height: 100%;
    padding: 0;
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    cursor: zoom-in;
}
.dgl-code :deep(.dgl-media-expand img) { display: block; max-height: 104px; }
.dgl-code :deep(.dgl-preview-player) {
    display: grid;
    grid-template-rows: minmax(0, 1fr) auto;
    gap: 3px;
    min-width: 0;
    width: 184px;
    height: 100%;
    max-width: 100%;
}
.dgl-code :deep(.dgl-preview-player > .dgl-media-expand) {
    min-height: 0;
    overflow: hidden;
    background: var(--panel-subtle);
}
.dgl-code :deep(.dgl-media-resized :is(.dgl-preview-player, .dgl-media-expand)) { width: 100%; height: 100%; }
.dgl-code :deep(.dgl-preview-player :is(img, video)), .dgl-code :deep(.dgl-media-resized .dgl-media-expand img) {
    display: block;
    width: 100%;
    height: 100%;
    max-height: 100%;
    object-fit: contain;
}
.dgl-code :deep(.dgl-playback-controls--audio) { grid-template-columns: auto minmax(0, 1fr) auto auto; }
.dgl-code :deep(.dgl-playback-volume) { position: relative; }
.dgl-code :deep(.dgl-playback-volume input) {
    position: absolute;
    z-index: 1;
    bottom: 100%;
    right: 0;
    box-sizing: border-box;
    width: 84px;
    height: 28px;
    padding: 0 8px;
    border: 1px solid var(--border);
    border-radius: 5px;
    background: var(--panel);
}
.dgl-code :deep(.dgl-playback-volume:not(:hover, :focus-within) input) {
    opacity: 0;
    pointer-events: none;
}
:global(.dgl-playback-controls) {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: 6px;
}
:global(.dgl-playback-controls button) {
    display: grid;
    place-items: center;
    width: 24px;
    height: 22px;
    padding: 0;
    border: 0;
    border-radius: 4px;
    background: var(--panel-subtle);
}
:global(.dgl-playback-controls button svg) { display: block; width: 16px; height: 16px; }
:global(.dgl-playback-controls input) {
    --playback-track: linear-gradient(to right, var(--primary) var(--playback-position, 0%), var(--border-strong) var(--playback-position, 0%));
    appearance: none;
    width: 100%;
    height: 22px;
    margin: 0;
    background: transparent;
    cursor: pointer;
}
:global(.dgl-playback-controls input::-webkit-slider-runnable-track) {
    height: 3px;
    border-radius: 3px;
    background: var(--playback-track);
}
:global(.dgl-playback-controls input::-moz-range-track) {
    height: 3px;
    border-radius: 3px;
    background: var(--playback-track);
}
:global(.dgl-playback-controls input::-webkit-slider-thumb) {
    appearance: none;
    width: 8px;
    height: 8px;
    margin-top: -2.5px;
    border-radius: 50%;
    background: var(--primary);
}
:global(.dgl-playback-controls input::-moz-range-thumb) {
    width: 8px;
    height: 8px;
    border: 0;
    border-radius: 50%;
    background: var(--primary);
}
.dgl-video-dialog {
    box-sizing: border-box;
    width: 100%;
    height: 100%;
    max-width: none;
    max-height: none;
    margin: 0;
    border: 0;
    color: #fff;
}
.dgl-video-dialog:not([open]) { display: none; }
.dgl-expanded-host { width: min(100%, 1280px); }
.dgl-expanded-host :deep(.dgl-expanded-player) {
    display: grid;
    grid-template-rows: minmax(0, 1fr) auto;
    border-radius: 12px;
    background: #111216;
    color: #f7f7f8;
    box-shadow: 0 20px 60px #0006;
}
.dgl-expanded-host :deep(.dgl-playback-picture) {
    display: block;
    min-height: 0;
    padding: 0;
    border: 0;
    border-radius: 12px 12px 0 0;
    overflow: hidden;
    background: #09090b;
    cursor: pointer;
}
.dgl-expanded-host :deep(.dgl-playback-picture :is(img, video)) {
    display: block;
    width: 100%;
    max-height: min(75dvh, calc(100dvh - 144px));
    object-fit: contain;
}
.dgl-expanded-host :deep(.dgl-expanded-player:fullscreen) {
    width: 100%;
    height: 100%;
    border-radius: 0;
}
.dgl-expanded-host :deep(.dgl-expanded-player:fullscreen .dgl-playback-picture) { border-radius: 0; }
.dgl-expanded-host :deep(.dgl-expanded-player:fullscreen .dgl-playback-picture :is(img, video)) {
    height: 100%;
    max-height: none;
}
.dgl-expanded-host :deep(.dgl-playback-controls) {
    display: block;
    padding: 0 14px 8px;
    transition: opacity 160ms ease;
}
.dgl-expanded-host :deep(.dgl-controls-idle .dgl-playback-controls:not(:has(:focus-visible))) {
    opacity: 0;
    pointer-events: none;
}
.dgl-expanded-host :deep(.dgl-playback-row), .dgl-expanded-host :deep(.dgl-playback-volume) {
    display: flex;
    align-items: center;
    gap: 6px;
}
.dgl-expanded-host :deep(.dgl-playback-row button) {
    flex: 0 0 auto;
    width: 36px;
    height: 34px;
    border-radius: 6px;
    background: transparent;
    color: inherit;
}
.dgl-expanded-host :deep(.dgl-playback-row button:hover:not(:disabled)) { background: #fff2; }
.dgl-expanded-host :deep(.dgl-playback-row button svg) { width: 22px; height: 22px; }
.dgl-expanded-host :deep(.dgl-playback-time) {
    margin-right: auto;
    white-space: nowrap;
    font-size: 12px;
    font-variant-numeric: tabular-nums;
    color: #dbdce3;
}
.dgl-expanded-host :deep(.dgl-playback-volume input) { width: clamp(36px, 8vw, 76px); }
.dgl-expanded-host :deep(.dgl-playback-controls input) {
    --playback-track: linear-gradient(to right, #f0f0f5 var(--playback-position, 0%), #fff4 var(--playback-position, 0%));
}
.dgl-expanded-host :deep(.dgl-playback-timeline) { position: relative; }
.dgl-expanded-host :deep(.dgl-playback-seek) { display: block; height: 24px; }
.dgl-expanded-host :deep(.dgl-playback-seek:is(:hover, :focus-visible, :active)::-webkit-slider-runnable-track) { height: 5px; }
.dgl-expanded-host :deep(.dgl-playback-seek:is(:hover, :focus-visible, :active)::-moz-range-track) { height: 5px; }
.dgl-expanded-host :deep(.dgl-playback-seek::-webkit-slider-thumb) { width: 12px; height: 12px; margin-top: -4.5px; background: #f0f0f5; }
.dgl-expanded-host :deep(.dgl-playback-seek:is(:hover, :focus-visible, :active)::-webkit-slider-thumb) { margin-top: -3.5px; }
.dgl-expanded-host :deep(.dgl-playback-seek::-moz-range-thumb) { width: 12px; height: 12px; background: #f0f0f5; }
.dgl-expanded-host :deep(.dgl-playback-volume input::-webkit-slider-thumb) { background: #f0f0f5; }
.dgl-expanded-host :deep(.dgl-playback-volume input::-moz-range-thumb) { background: #f0f0f5; }
.dgl-expanded-host :deep(.dgl-playback-hint) {
    position: absolute;
    bottom: 100%;
    translate: -50% 0;
    padding: 4px 7px;
    border-radius: 4px;
    background: #111216e6;
    color: #fff;
    font: 12px var(--font-mono);
    pointer-events: none;
}
.dgl-expanded-host :deep(:is(button, input):focus-visible) { outline: 2px solid #fff; outline-offset: -2px; }
@media (prefers-reduced-motion: reduce) {
    .dgl-expanded-host :deep(.dgl-playback-controls) { transition: none; }
}
.dgl-code :deep(.dgl-media-block [hidden]) { display: none; }
.dgl-code :deep(.dgl-media-block .dgl-media-unavailable) { min-width: 0; max-width: 100%; height: auto; }
.dgl-code :deep(.dgl-media-unavailable > :not(p)) { display: none; }
.dgl-code :deep(.dgl-media-unavailable p) {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    margin: 0;
    color: var(--muted);
}
</style>
