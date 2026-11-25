<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { getCapabilities, getJob, listDglScripts, loadDglScript, saveDglScript, submitDglJob } from "../lib/api";
import { createStoredRef } from "../lib/settings";
import type { DglJob } from "../lib/types";
import DglEditor from "./DglEditor.vue";
import GenerationProgress from "./GenerationProgress.vue";

const props = defineProps<{ active: boolean; pollIntervalMs: number }>();
const emit = defineEmits<{ (event: "expand-image", src: string, alt: string): void }>();

const starter = '# version: 0.0.0\n\nfn main() {\n    return "Hello, DGL"\n}\n';
const directory = ref("");
const files = ref<string[]>([]);
const fileSearch = ref("");
const name = ref("untitled.dgl");
const source = ref(starter);
const lastOpened = createStoredRef("sdcpp-webui-dgl-last-script", "", (value: unknown) => typeof value === "string" ? value : "");
const openedName = ref("");
const cleanSource = ref(source.value);
const busy = ref(false);
const fileError = ref("");
const saveNameDialog = ref<HTMLDialogElement>();
const saveNameInput = ref<HTMLInputElement>();
const saveName = ref("");
const namingFile = ref(false);
const running = ref(false);
const runError = ref("");
const job = ref<DglJob | null>(null);
const resultDialog = ref<HTMLDialogElement>();
const resultDialogOpen = ref(false);
const editor = ref<InstanceType<typeof DglEditor>>();
const documentRevision = ref(0);
let runAbort: AbortController | undefined;

const mediaAllowed = ref(false);
const mediaEnabled = createStoredRef("sdcpp-webui-dgl-media-view", true, (value: unknown) => value !== false);
const canViewMedia = computed(() => props.active && mediaAllowed.value && mediaEnabled.value);
const outputRevision = ref(0);
const searchTerm = computed(() => fileSearch.value.trim().toLowerCase());
const visibleFiles = computed(() => files.value.filter((file) => file.toLowerCase().includes(searchTerm.value)));
const modified = computed(() => source.value !== cleanSource.value);
const runResult = computed(() => {
    const result = job.value?.status === "completed" ? job.value.result : null;
    return result && (result.outputs.length || result.media.length) ? result : null;
});

const dtypeNames: Record<number, string> = { 1: "u8", 2: "i32", 3: "i64", 4: "f32", 5: "f64" };

function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

async function fileAction(action: () => Promise<void>): Promise<void> {
    if (busy.value) return;
    busy.value = true;
    fileError.value = "";
    try {
        await action();
    } catch (error) {
        fileError.value = describeError(error);
    } finally {
        busy.value = false;
    }
}

function setDocument(file: string, text: string, saved: boolean, replaceEditor = true): void {
    name.value = file;
    source.value = text;
    cleanSource.value = text;
    openedName.value = saved ? file : "";
    if (saved) lastOpened.value = file;
    if (replaceEditor) documentRevision.value += 1;
}

function nextName(stem: string): string {
    let next = stem + ".dgl";
    for (let count = 2; files.value.some((file) => file.toLowerCase() === next.toLowerCase()); ++count) {
        next = stem + "-" + count + ".dgl";
    }
    return next;
}

function refreshFiles(restoreLast = false): Promise<void> {
    return fileAction(async () => {
        const response = await listDglScripts();
        directory.value = response.directory;
        files.value = response.scripts;
        if (restoreLast && lastOpened.value && !openedName.value && !modified.value) {
            const name = lastOpened.value;
            if (files.value.includes(name)) {
                const script = await loadDglScript(name);
                setDocument(name, script.source, true);
                return;
            }
            lastOpened.value = "";
        }
        if (!openedName.value && !modified.value && name.value === "untitled.dgl") {
            setDocument(nextName("untitled"), source.value, false);
        }
    });
}

function mayReplaceDocument(): boolean {
    return !modified.value || window.confirm("Discard unsaved changes?");
}

function newScript(): void {
    if (!mayReplaceDocument()) return;
    fileError.value = "";
    setDocument(nextName("untitled"), starter, false);
    void nextTick(() => editor.value?.focus());
}

function openScript(file: string): Promise<void> | undefined {
    if (file === openedName.value || !mayReplaceDocument()) return;
    return fileAction(async () => {
        const response = await loadDglScript(file);
        setDocument(file, response.source, true);
    });
}

function showSaveAs(): void {
    if (busy.value || !saveNameDialog.value) return;
    fileError.value = "";
    saveName.value = openedName.value ? nextName(openedName.value.slice(0, -".dgl".length) + "-copy") : name.value;
    saveNameDialog.value.showModal();
    namingFile.value = true;
    void nextTick(() => saveNameInput.value?.select());
}

function saveScript(requested: string): Promise<void> | undefined {
    const filename = requested.trim();
    if (!filename) return;
    const target = filename.endsWith(".dgl") ? filename : filename + ".dgl";
    return fileAction(async () => {
        const text = source.value;
        const saved = await saveDglScript(target, text, target === openedName.value ? cleanSource.value : undefined);
        if (!files.value.includes(saved.name)) files.value = [...files.value, saved.name].sort();
        setDocument(saved.name, text, true, false);
        saveNameDialog.value?.close();
    });
}

function saveCurrentScript(): void {
    if (openedName.value) void saveScript(openedName.value);
    else showSaveAs();
}

function editKeydown(event: KeyboardEvent): void {
    if (!(event.ctrlKey || event.metaKey)) return;
    if (event.key === "Enter") {
        event.preventDefault();
        void runScript();
    }
    if (event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (event.shiftKey) showSaveAs();
        else saveCurrentScript();
    }
}

function showRunResult(): void {
    if (!resultDialog.value) return;
    resultDialog.value.showModal();
    resultDialogOpen.value = true;
}

async function runScript(): Promise<void> {
    if (running.value || !source.value.trim()) return;
    resultDialog.value?.close();
    const abort = new AbortController();
    runAbort = abort;
    running.value = true;
    job.value = null;
    runError.value = "";
    try {
        let status = await submitDglJob(source.value, abort.signal);
        while (!abort.signal.aborted) {
            job.value = status;
            if (status.status !== "queued" && status.status !== "generating") break;
            await new Promise((resolve) => window.setTimeout(resolve, props.pollIntervalMs));
            if (!abort.signal.aborted) status = await getJob<DglJob>("", status.id, abort.signal);
        }
        if (!abort.signal.aborted && status.status === "completed") outputRevision.value += 1;
    } catch (error) {
        if (!abort.signal.aborted) runError.value = describeError(error);
    } finally {
        running.value = false;
    }
}

onMounted(() => {
    void refreshFiles(true);
    void getCapabilities("").then((response) => { mediaAllowed.value = response.media_view === true; }, () => {});
});
onBeforeUnmount(() => runAbort?.abort());
</script>

<template>
    <main class="dgl-workspace" aria-label="DGL workspace">
        <aside class="panel dgl-files" aria-label="Script files">
            <div class="dgl-heading">
                <h1>DGL scripts</h1>
                <button class="btn-secondary" type="button" :disabled="busy" @click="newScript">New</button>
            </div>
            <div class="dgl-directory">
                <code :title="directory">{{ directory }}</code>
                <button class="btn-ghost" type="button" :disabled="busy" @click="refreshFiles()">Refresh</button>
            </div>
            <div v-if="files.length" class="field dgl-file-search">
                <input v-model="fileSearch" type="search" placeholder="Search scripts" aria-label="Search scripts" />
            </div>
            <ul v-if="visibleFiles.length">
                <li v-for="file in visibleFiles" :key="file">
                    <button class="dgl-file" type="button" :aria-current="openedName === file ? 'true' : undefined" :disabled="busy" @click="openScript(file)">{{ file }}</button>
                </li>
            </ul>
            <p v-else-if="!busy && !fileError">{{ files.length ? 'No matching scripts.' : 'No saved scripts.' }}</p>
        </aside>

        <section class="panel dgl-editor" aria-label="Script editor" @keydown="editKeydown">
            <div class="dgl-toolbar">
                <div class="dgl-document">
                    <h2 :title="name">{{ name }}</h2>
                    <span v-if="modified || !openedName" class="dgl-dirty" role="img" aria-label="Unsaved changes" title="Unsaved changes"></span>
                </div>
                <div class="dgl-toolbar__actions">
                    <label v-if="mediaAllowed" class="dgl-media-toggle"><input v-model="mediaEnabled" type="checkbox" /> Media view</label>
                    <button v-if="openedName" class="btn-ghost" type="button" :disabled="busy" aria-haspopup="dialog" @click="showSaveAs">Save as…</button>
                    <button class="btn-secondary" type="button" :disabled="busy" @click="saveCurrentScript">Save</button>
                    <button class="btn" type="button" :disabled="running || !source.trim()" @click="runScript">{{ running ? 'Running…' : 'Run' }}</button>
                </div>
            </div>
            <p v-if="fileError && !namingFile" class="status-message status-message--error" role="alert">{{ fileError }}</p>
            <p v-if="runError || job?.error" class="status-message status-message--error" role="alert">{{ runError || job?.error?.message }}</p>
            <DglEditor ref="editor" v-model="source" :document-revision="documentRevision" :read-only="busy"
                :media-view="canViewMedia" :output-revision="outputRevision" @save="saveCurrentScript" @save-as="showSaveAs" @run="runScript"
                @expand-image="(src, alt) => emit('expand-image', src, alt)" />
            <GenerationProgress v-if="active && job" class="dgl-progress" :job="job" show-finished-progress>
                <template #actions>
                    <div v-if="runResult" class="stage-actions">
                        <button class="btn-ghost" type="button" aria-haspopup="dialog" @click="showRunResult">View result</button>
                    </div>
                </template>
            </GenerationProgress>
        </section>

        <dialog ref="saveNameDialog" class="generation-details dgl-save-dialog" aria-labelledby="dgl-save-title"
            @cancel="busy && $event.preventDefault()" @close="namingFile = false; fileError = ''">
            <div class="generation-details__header">
                <h2 id="dgl-save-title">Save script as</h2>
            </div>
            <form class="generation-details__body dgl-save-form" @submit.prevent="saveScript(saveName)">
                <div class="field">
                    <label for="dgl-save-name">File name</label>
                    <input id="dgl-save-name" ref="saveNameInput" v-model="saveName" :disabled="busy" autocomplete="off" required autofocus />
                </div>
                <p v-if="fileError" class="status-message status-message--error" role="alert">{{ fileError }}</p>
                <div class="dgl-save-actions">
                    <button class="btn-ghost" type="button" :disabled="busy" @click="saveNameDialog?.close()">Cancel</button>
                    <button class="btn" type="submit" :disabled="busy || !saveName.trim()">Save</button>
                </div>
            </form>
        </dialog>

        <dialog v-if="runResult" ref="resultDialog" class="generation-details"
            aria-labelledby="dgl-run-result-title" @close="resultDialogOpen = false">
            <div class="generation-details__header">
                <h2 id="dgl-run-result-title">Run result</h2>
                <form method="dialog"><button class="btn-ghost" type="submit" autofocus>Close</button></form>
            </div>
            <div v-if="resultDialogOpen" class="generation-details__body">
                <span class="dgl-unsaved">{{ runResult.type }}</span>
                <article v-for="media in runResult.media" :key="media.name" class="dgl-result">
                    <h3>{{ media.name }}</h3>
                    <p v-if="media.error" class="status-message status-message--error">{{ media.error.message }}</p>
                    <template v-else-if="media.b64_json">
                        <img v-if="media.mime_type === 'image/png'" :src="`data:${media.mime_type};base64,${media.b64_json}`" :alt="media.name" />
                        <video v-else-if="media.mime_type === 'video/webm'" :src="`data:${media.mime_type};base64,${media.b64_json}`" controls preload="metadata" />
                        <a :href="`data:${media.mime_type};base64,${media.b64_json}`" :download="media.name + (media.mime_type === 'image/png' ? '.png' : media.mime_type === 'video/webm' ? '.webm' : '.avi')">Download {{ media.name }}</a>
                    </template>
                </article>
                <article v-for="output in runResult.outputs" :key="output.name" class="dgl-result">
                    <h3>{{ output.name }}</h3>
                    <div class="dgl-result__shape"><code>{{ dtypeNames[output.dtype] ?? output.dtype }} [{{ output.shape.join(', ') }}]</code><span>{{ output.bytes.toLocaleString() }} B</span></div>
                    <pre v-if="output.value !== undefined">{{ output.value }}</pre>
                </article>
            </div>
        </dialog>
    </main>
</template>

<style scoped>
.dgl-workspace {
    display: grid;
    grid-template-columns: minmax(172px, 0.8fr) minmax(0, 4.35fr);
    align-items: start;
    gap: 14px;
    margin: 22px 0 0;
}
.dgl-workspace > .panel { min-width: 0; padding: 14px; }
.dgl-heading, .dgl-toolbar, .dgl-directory, .dgl-toolbar__actions, .dgl-result__shape {
    display: flex;
    align-items: center;
    gap: 8px;
}
.dgl-heading, .dgl-directory, .dgl-result__shape { justify-content: space-between; }
.dgl-heading h1 { margin: 0; font-size: 15px; }
.dgl-directory { margin: 6px 0; font-size: 12px; color: var(--muted); }
.dgl-directory code { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dgl-file-search { margin: 8px 0; }
.dgl-file-search input { min-width: 0; padding: 6px 8px; font-size: 12px; }
.dgl-files ul { padding: 0; margin: 0; list-style: none; max-height: 67dvh; overflow: auto; }
.dgl-file {
    background: transparent;
    border: 0;
    border-radius: 6px;
    text-align: left;
    display: block;
    padding: 7px 8px;
    width: 100%;
    overflow-wrap: anywhere;
    font-size: 12px;
}
.dgl-file:hover, .dgl-file[aria-current] { background: var(--select-option-selected-bg); }
.dgl-toolbar { flex-wrap: wrap; }
.dgl-toolbar label, .dgl-unsaved { font-size: 12px; color: var(--muted); }
.dgl-document { display: flex; align-items: center; gap: 8px; flex: 1 1 150px; min-width: 0; }
.dgl-document h2 { margin: 0; overflow: hidden; font: 600 14px var(--font-mono); text-overflow: ellipsis; white-space: nowrap; }
.dgl-dirty { width: 7px; height: 7px; flex: 0 0 auto; border-radius: 50%; background: var(--muted); }
.dgl-toolbar__actions { margin-left: auto; flex-wrap: wrap; }
.dgl-media-toggle { display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; }
.dgl-workspace p { font-size: 13px; }
.dgl-progress { margin-top: 8px; }
.dgl-save-form { display: grid; gap: 14px; }
.dgl-save-actions { display: flex; justify-content: flex-end; gap: 8px; }
.dgl-result { padding: 12px 0; border-top: 1px solid var(--border); }
.dgl-result:first-of-type { margin-top: 12px; }
.dgl-result h3 { font: 600 13px var(--font-mono); margin: 0 0 6px; overflow-wrap: anywhere; }
.dgl-result__shape { font-size: 12px; color: var(--muted); flex-wrap: wrap; }
.dgl-result :is(img, video) { display: block; max-width: 100%; max-height: 360px; object-fit: contain; margin-top: 8px; border-radius: 6px; background: var(--panel-subtle); }
.dgl-result pre { white-space: pre-wrap; overflow-wrap: anywhere; font: 13px/1.5 var(--font-mono); margin: 8px 0 0; }
@media (max-width: 1050px) {
    .dgl-workspace { grid-template-columns: minmax(150px, 1fr) minmax(0, 4fr); }
}
@media (max-width: 620px) {
    .dgl-workspace { grid-template-columns: minmax(0, 1fr); }
    .dgl-files ul { max-height: 148px; }
}
</style>
