<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import CollapsibleSection from "./CollapsibleSection.vue";
import SearchableSelect from "./SearchableSelect.vue";
import { createStoredRef } from "../lib/settings";
import { getModelFiles, getModelStatus, getRecipes, refreshModels } from "../lib/api";
import type { CatalogError, ModelFile, ModelStatus, Recipe } from "../lib/types";

const props = defineProps<{ baseUrl: string; busy: boolean; applyDefaults: boolean; currentRecipe?: Recipe; loraSummary?: string; embedded?: boolean }>();
const emit = defineEmits<{
    (event: "update:applyDefaults", value: boolean): void;
    (event: "changed"): void;
    (event: "recipe", value: Recipe): void;
    (event: "selection", value: Record<string, string>, complete: boolean): void;
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
const currentRecipe = computed(() => props.currentRecipe ?? status.value?.runtime_recipe);
const availableRecipes = computed(() => currentRecipe.value ? [currentRecipe.value, ...recipes.value] : recipes.value);
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
const refreshing = ref(false);
const error = ref("");
const expanded = createStoredRef<boolean>("sdcpp-webui-models-open", true, (value: unknown) => typeof value === "boolean" ? value : true);
const recipe = computed(() => availableRecipes.value.find((item) => item.id === selectedId.value));
const statusSummary = computed(() => [recipe.value?.name || "No recipe selected", props.loraSummary].filter(Boolean).join(" · "));
const orderedSlots = computed(() => [...(recipe.value?.slots || [])].sort((a, b) => Number(b.required) - Number(a.required)));
const missingRequiredGroups = computed(() => (recipe.value?.required_any || [])
    .filter((group) => !group.some(slotSelected))
    .map((group) => ({
        id: group.join(":"),
        label: group.map((id) => recipe.value?.slots.find((slot) => slot.id === id)?.label || id).join(" or "),
    })));
const catalogRecipe = computed(() => recipe.value?.source === "builtin" || recipe.value?.source === "user");
const complete = computed(() => Boolean(catalogRecipe.value && recipe.value?.slots.every((slot) =>
    !slot.required || slotSelected(slot.id)) && !missingRequiredGroups.value.length));
function slotSelected(id: string): boolean {
    const slot = recipe.value?.slots.find((item) => item.id === id);
    return !!slot && filesForSlot(slot).some((file) => file.id === selection.value[id]);
}
let revision = 0;
let restorePending = true;

function filesForSlot(slot: Recipe["slots"][number]): ModelFile[] {
    return files.value.filter((file) => (slot.categories || [slot.category]).includes(file.category));
}

function selectRecipe(id: string): void {
    saveSelection();
    selectedId.value = id;
    restoreSelection();
    if (recipe.value) emit("recipe", recipe.value);
}

function restoreSelection(): void {
    const saved = savedSelections.value[storageScope.value];
    const current = saved?.modelsByRecipe[selectedId.value] ?? recipe.value?.models ?? {};
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
        status.value = next;
        const restoring = restorePending;
        if (!availableRecipes.value.some((item) => item.id === selectedId.value)) {
            selectedId.value = next.runtime_recipe?.id || "";
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

watch([selection, complete], ([value, selected]) => emit("selection", { ...value }, selected), { deep: true });

function saveSelection(): void {
    if (restorePending || !catalogRecipe.value) return;
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
    status.value = null;
    recipes.value = [];
    files.value = [];
    restorePending = true;
    selectedId.value = savedSelections.value[storageScope.value]?.recipe || "";
    selection.value = {};
    void refresh(false);
}, { immediate: true });

onBeforeUnmount(() => { revision++; });
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
                <SearchableSelect id="model-recipe" :model-value="selectedId" :disabled="busy || refreshing"
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
                <SearchableSelect :id="'model-slot-' + slot.id" v-model="selection[slot.id]" :disabled="busy || refreshing"
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
            <button class="btn-secondary" type="button" :disabled="refreshing" @click="refresh(true)">{{ refreshing ? "Refreshing..." : "Refresh files & recipes" }}</button>
        </div>
        <div v-if="error" class="status-message status-message--error">{{ error }}</div>
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
