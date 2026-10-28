<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import CollapsibleSection from "./CollapsibleSection.vue";
import SearchableSelect from "./SearchableSelect.vue";
import { createStoredRef } from "../lib/settings";
import { getModelFiles, getModelStatus, getRecipes, loadModel, refreshModels, unloadModel } from "../lib/api";
import type { CatalogError, ModelFile, ModelStatus, Recipe } from "../lib/types";

const props = defineProps<{ baseUrl: string; busy: boolean; applyDefaults: boolean; loraSummary?: string; embedded?: boolean }>();
const emit = defineEmits<{
    (event: "update:applyDefaults", value: boolean): void;
    (event: "status", value: ModelStatus): void;
    (event: "changed"): void;
    (event: "recipe", value: Recipe): void;
    (event: "selection", value: Record<string, string>): void;
    (event: "catalogRecipe", value: Recipe | null): void;
}>();
const applyDefaults = computed({
    get: () => props.applyDefaults,
    set: (value: boolean) => emit("update:applyDefaults", value),
});
const recipes = ref<Recipe[]>([]);
const files = ref<ModelFile[]>([]);
const catalogErrors = ref<CatalogError[]>([]);
const status = ref<ModelStatus | null>(null);
const availableRecipes = computed(() => status.value?.runtime_recipe
    ? [status.value.runtime_recipe, ...recipes.value] : recipes.value);
const selectedId = ref("");
const selection = ref<Record<string, string>>({});
interface SavedModelSelection {
    recipe: string;
    modelsByRecipe: Record<string, Record<string, string>>;
}
function isModelSelection(value: unknown): value is Record<string, string> {
    return Boolean(value && typeof value === "object" && !Array.isArray(value) && Object.values(value).every((id) => typeof id === "string"));
}
const savedSelections = createStoredRef<Record<string, SavedModelSelection>>("sdcpp-webui-model-selections", {}, (value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const normalized: Record<string, SavedModelSelection> = {};
    let changed = false;
    for (const [base, saved] of Object.entries(value)) {
        if (saved && typeof saved.recipe === "string") {
            if (saved.modelsByRecipe && typeof saved.modelsByRecipe === "object" && !Array.isArray(saved.modelsByRecipe) &&
                Object.values(saved.modelsByRecipe).every(isModelSelection)) {
                normalized[base] = saved;
                continue;
            }
            if (isModelSelection(saved.models)) {
                normalized[base] = { recipe: saved.recipe, modelsByRecipe: { [saved.recipe]: saved.models } };
            }
        }
        changed = true;
    }
    return changed ? normalized : value as Record<string, SavedModelSelection>;
});
const storageScope = computed(() => (props.baseUrl.trim() || window.location.origin + window.location.pathname).replace(/\/+$/, ""));
const working = ref(false);
const refreshing = ref(false);
const error = ref("");
const expanded = createStoredRef<boolean>("sdcpp-webui-models-open", true, (value: unknown) => typeof value === "boolean" ? value : true);
const loadTiming = computed(() => {
    const seconds = status.value?.load_elapsed_seconds;
    if (seconds == null || !Number.isFinite(seconds)) return "";
    const duration = seconds < 60 ? `${seconds.toFixed(1)}s` : `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
    if (status.value?.state === "loading") return `Loading for ${duration}`;
    if (status.value?.state === "ready") return `Loaded in ${duration}`;
    if (status.value?.state === "error") return `Load failed after ${duration}`;
    return "";
});
const statusSummary = computed(() => {
    if (!status.value || status.value.state === "empty") return [recipe.value?.name || "No recipe selected", "Not loaded", props.loraSummary].filter(Boolean).join(" · ");
    const name = availableRecipes.value.find((item) => item.id === status.value?.recipe)?.name;
    return [status.value?.state || "Connecting", name || (status.value?.origin === "command_line" ? "loaded from command line" : ""), loadTiming.value, props.loraSummary].filter(Boolean).join(" · ");
});
const recipe = computed(() => availableRecipes.value.find((item) => item.id === selectedId.value));
const orderedSlots = computed(() => [...(recipe.value?.slots || [])].sort((a, b) => Number(b.required) - Number(a.required)));
const missingRequiredGroups = computed(() => (recipe.value?.required_any || [])
    .filter((group) => !group.some(slotSelected))
    .map((group) => ({
        id: group.join(":"),
        label: group.map((id) => recipe.value?.slots.find((slot) => slot.id === id)?.label || id).join(" or "),
    })));
const disabled = computed(() => props.busy || working.value || status.value?.state === "loading");
const complete = computed(() => recipe.value && recipe.value.source !== "command_line" && recipe.value.slots.every((slot) =>
    !slot.required || slotSelected(slot.id)) && !missingRequiredGroups.value.length);
function slotSelected(id: string): boolean {
    const slot = recipe.value?.slots.find((item) => item.id === id);
    return !!slot && filesForSlot(slot).some((file) => file.id === selection.value[id]);
}
let timer = 0;
let revision = 0;
let polling = false;
let previousStatus = "";
let previousRevision: number | null = null;
let previousActiveRecipe: string | null = null;
let restorePending = true;

function acceptStatus(next: ModelStatus): void {
    const signature = JSON.stringify(next);
    const changed = previousStatus !== "" && previousStatus !== signature;
    // The server bumps the revision whenever a load starts, succeeds, or
    // fails. The revision bump (with a previous-active-recipe fallback for
    // servers that do not report one) detects transitions between ready
    // states that polling skipped (fast loads, background-tab throttling).
    // An intentional preview changes only the local selection, never the
    // server, so it is left untouched. The first observation only
    // establishes the baseline.
    const loadTransitioned = next.recipe != null &&
        ((next.revision != null && previousRevision != null && next.revision > previousRevision) ||
            (previousActiveRecipe != null && next.recipe !== previousActiveRecipe));
    previousStatus = signature;
    previousRevision = next.revision ?? previousRevision;
    previousActiveRecipe = next.recipe;
    status.value = next;
    emit("status", next);
    if (selectedId.value === "@command-line" && !next.runtime_recipe) {
        selectedId.value = next.recipe || "";
        restoreSelection();
        emit("catalogRecipe", recipe.value || null);
    }
    // Follow the server when its active model becomes ready here: the load
    // may have been started by another client (e.g. an external script), or
    // it may have finished while this page was opening. Loading and error
    // states keep reporting status but do not switch the selector or apply
    // generation defaults, since the model has not loaded successfully.
    // The selector snaps to the server's recipe and its resolved components,
    // and a recipe switch applies generation defaults exactly as a manual
    // selection would.
    if (loadTransitioned && next.state === "ready" && next.recipe) {
        const switchedRecipe = next.recipe !== selectedId.value;
        if (switchedRecipe) selectedId.value = next.recipe;
        restoreSelection(true);
        if (switchedRecipe && recipe.value) emit("recipe", recipe.value);
    }
    if (changed && next.state !== "loading") emit("changed");
}

function filesForSlot(slot: Recipe["slots"][number]): ModelFile[] {
    return files.value.filter((file) => (slot.categories || [slot.category]).includes(file.category));
}

function selectRecipe(id: string): void {
    saveSelection();
    selectedId.value = id;
    restoreSelection();
    if (recipe.value) emit("recipe", recipe.value);
}

function restoreSelection(fromServer = false): void {
    const saved = savedSelections.value[storageScope.value];
    const serverSelection = status.value && status.value.recipe === selectedId.value ? status.value.models : undefined;
    // Following the server's active load must show the components the server
    // actually resolved, so a later "Load models" re-submits the same
    // configuration. A local restore prefers the saved per-recipe selection,
    // then the live status for the same recipe, then recipe-declared model
    // defaults, so a fresh browser still pre-fills slots.
    const current = fromServer
        ? (serverSelection ?? saved?.modelsByRecipe[selectedId.value] ?? recipe.value?.models ?? {})
        : (saved?.modelsByRecipe[selectedId.value] ?? serverSelection ?? (recipe.value?.models || {}));
    selection.value = Object.fromEntries((recipe.value?.slots || []).map((slot) => {
        const value = current[slot.id] ?? (slot.id === "tae" ? current.taesd : slot.id === "taesd" ? current.tae : "") ?? "";
        return [slot.id, filesForSlot(slot).some((file) => file.id === value) ? value : ""];
    }));
}

async function refresh(rescan = true): Promise<void> {
    const current = revision;
    const base = props.baseUrl;
    refreshing.value = true;
    error.value = "";
    try {
        if (rescan) await refreshModels(base);
        const [catalog, modelFiles, next] = await Promise.all([getRecipes(base), getModelFiles(base), getModelStatus(base)]);
        if (current !== revision) return;
        recipes.value = catalog.recipes;
        files.value = modelFiles.files;
        catalogErrors.value = catalog.errors;
        acceptStatus(next);
        const restoring = restorePending;
        if (restoring && next.runtime_recipe) selectedId.value = next.runtime_recipe.id;
        if (!availableRecipes.value.some((item) => item.id === selectedId.value)) {
            const activeId = next.runtime_recipe?.id || next.recipe;
            selectedId.value = availableRecipes.value.some((item) => item.id === activeId)
                ? activeId! : "";
            restoreSelection();
        } else if (restoring) {
            restoreSelection();
        }
        selection.value = Object.fromEntries((recipe.value?.slots || []).map((slot) => {
            const value = selection.value[slot.id] || "";
            return [slot.id, filesForSlot(slot).some((file) => file.id === value) ? value : ""];
        }));
        restorePending = false;
        if (restoring && recipe.value) emit("recipe", recipe.value);
        emit("catalogRecipe", recipe.value || null);
        if (rescan) emit("changed");
    } catch (cause) {
        if (current === revision) error.value = cause instanceof Error ? cause.message : String(cause);
    } finally {
        if (current === revision) refreshing.value = false;
    }
}

async function change(unload = false): Promise<void> {
    const current = revision;
    const base = props.baseUrl;
    working.value = true;
    error.value = "";
    try {
        const next = unload ? await unloadModel(base) : await loadModel(base, selectedId.value, selection.value);
        if (current === revision) acceptStatus(next);
    } catch (cause) {
        if (current === revision) error.value = cause instanceof Error ? cause.message : String(cause);
    } finally {
        if (current === revision) {
            try {
                const next = await getModelStatus(base);
                if (current === revision) acceptStatus(next);
            } catch { /* Preserve the action error if the connection is lost. */ }
            if (current === revision) working.value = false;
        }
    }
}

async function poll(): Promise<void> {
    if (polling) return;
    const current = revision;
    polling = true;
    try {
        const next = await getModelStatus(props.baseUrl);
        if (current === revision) acceptStatus(next);
    } catch { /* Refresh and actions report connection errors. */ }
    finally { polling = false; }
}

watch(selection, (value) => emit("selection", { ...value }), { deep: true });

function saveSelection(): void {
    if (restorePending || !recipe.value || recipe.value.source === "command_line") return;
    savedSelections.value = {
        ...savedSelections.value,
        [storageScope.value]: {
            recipe: selectedId.value,
            modelsByRecipe: {
                ...savedSelections.value[storageScope.value]?.modelsByRecipe,
                [selectedId.value]: { ...selection.value },
            },
        },
    };
}

watch([selectedId, selection], saveSelection, { deep: true });

watch(() => props.baseUrl, () => {
    revision++;
    previousStatus = "";
    previousRevision = null;
    previousActiveRecipe = null;
    status.value = null;
    recipes.value = [];
    files.value = [];
    restorePending = true;
    selectedId.value = savedSelections.value[storageScope.value]?.recipe || "";
    selection.value = {};
    working.value = false;
    window.clearInterval(timer);
    void refresh(false);
    timer = window.setInterval(poll, 2000);
}, { immediate: true });

onBeforeUnmount(() => { revision++; window.clearInterval(timer); });
</script>

<template>
    <CollapsibleSection class="model-selector" :class="{ 'model-selector--embedded': embedded }" :open="embedded || expanded" @toggle="expanded = !expanded">
        <template #header>
            <span class="module-card__eyebrow">Models</span>
            <span class="module-card__summary">{{ statusSummary }}</span>
        </template>
        <p v-if="embedded" class="hint" role="status">{{ statusSummary }}</p>
        <div class="field model-selector__recipe">
            <label id="model-recipe-label" for="model-recipe">Recipe</label>
            <div class="model-selector__recipe-controls">
                <SearchableSelect id="model-recipe" :model-value="selectedId" :disabled="disabled || refreshing"
                    :options="availableRecipes.map((item) => ({ value: item.id, label: item.name + ' · ' + item.source }))"
                    placeholder="Select a recipe" @update:model-value="selectRecipe" />
                <label class="checkbox">
                    <input v-model="applyDefaults" type="checkbox" />
                    <span>Apply recipe defaults</span>
                </label>
            </div>
        </div>
        <p v-if="recipe?.description || recipe?.model_url" class="hint">
            {{ recipe.description }}
            <a v-if="recipe.model_url" :href="recipe.model_url" target="_blank" rel="noopener noreferrer">Hugging Face ↗</a>
        </p>
        <div class="model-selector__slots">
            <div v-for="slot in orderedSlots" :key="slot.id" class="field">
                <label :id="'model-slot-' + slot.id + '-label'" :for="'model-slot-' + slot.id">{{ slot.label }}{{ slot.required ? " *" : "" }}</label>
                <SearchableSelect :id="'model-slot-' + slot.id" v-model="selection[slot.id]" :disabled="disabled || refreshing"
                    :options="filesForSlot(slot).map((file) => ({ value: file.id, label: file.name || file.id.slice(file.category.length + 1) }))"
                    :placeholder="slot.required ? 'Select a model' : 'None'" :allow-empty="!slot.required" />
                <span v-if="slot.required && !filesForSlot(slot).length" class="hint">No files in {{ (slot.categories || [slot.category]).map((category) => category + "/").join(", ") }}. Add files and refresh.</span>
            </div>
        </div>
        <div class="model-selector__requirements" aria-live="polite">
            <p v-for="group in missingRequiredGroups" :key="group.id" class="hint">
                Select at least one: {{ group.label }}.
            </p>
        </div>
        <div class="actions model-selector__actions">
            <button class="btn" type="button" :disabled="disabled || refreshing || !complete" @click="change(false)">{{ working ? "Applying..." : "Load models" }}</button>
            <button class="btn-secondary" type="button" :disabled="disabled || status?.state !== 'ready'" @click="change(true)">Unload</button>
            <button class="btn-secondary" type="button" :disabled="refreshing || working" @click="refresh(true)">{{ refreshing ? "Refreshing..." : "Refresh files & recipes" }}</button>
        </div>
        <p v-if="!status || status.state === 'empty'" class="hint">Select a recipe and its required models, then load to start generating.</p>
        <p v-if="status?.state === 'loading'" class="hint">Loading models. This can take a few minutes.</p>
        <div v-if="error || status?.error" class="status-message status-message--error">{{ error || status?.error }}</div>
        <div v-for="(issue, index) in catalogErrors" :key="index" class="status-message status-message--error">{{ issue.file }}: {{ issue.message }}</div>
        <slot name="lora" />
    </CollapsibleSection>
</template>

<style scoped>
.model-selector { overflow: visible; }
.model-selector :deep(> .advanced-group__toggle) { border-radius: var(--radius-md) var(--radius-md) 0 0; }
.model-selector :deep(> .advanced-group__toggle[aria-expanded="false"]) { border-bottom: 0; border-radius: var(--radius-md); }
.model-selector :deep(> .advanced-group__content) { border-radius: 0 0 var(--radius-md) var(--radius-md); }
.model-selector.model-selector--embedded { border: 0; padding: 0; background: transparent; box-shadow: none; }
.model-selector--embedded :deep(> .advanced-group__toggle) { display: none; }
.model-selector--embedded :deep(> .advanced-group__content) { padding: 0; background: transparent; border-radius: inherit; }
.model-selector__recipe { width: 100%; }
.model-selector__recipe-controls { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 16px; }
.model-selector__recipe-controls .checkbox { justify-self: start; min-height: 24px; white-space: normal; line-height: 1.4; cursor: pointer; }
.model-selector__recipe-controls .checkbox input { flex: 0 0 16px; width: 16px; height: 16px; margin: 0; padding: 0; }
.model-selector p { margin: 0; }
.model-selector__requirements:empty { display: none; }
.model-selector__requirements .hint { color: var(--warning); }
.model-selector__actions { border-top: 1px solid var(--border); padding-top: 16px; }
.model-selector__slots { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(260px, 100%), 1fr)); gap: 8px 16px; }
.model-selector__slots > .field { display: grid; grid-template-rows: subgrid; grid-row: span 3; min-width: 0; }
.model-selector__slots label { align-self: end; overflow-wrap: anywhere; }
</style>
