<script setup lang="ts">
import { nextTick, ref, watch } from "vue";
import type { PromptEnhancement } from "../lib/prompt-enhancement";

const props = defineProps<{ enhancement: PromptEnhancement }>();
const namingPreset = ref(false);
const newPresetName = ref("");
const nameInput = ref<HTMLInputElement | null>(null);
const saveButton = ref<HTMLButtonElement | null>(null);

async function beginSavePreset(): Promise<void> {
    newPresetName.value = "";
    namingPreset.value = true;
    await nextTick();
    nameInput.value?.focus();
}

async function cancelSavePreset(): Promise<void> {
    namingPreset.value = false;
    newPresetName.value = "";
    await nextTick();
    saveButton.value?.focus();
}

function saveNewPreset(): void {
    if (props.enhancement.savePreset(newPresetName.value)) cancelSavePreset();
}

watch(() => props.enhancement.activePresetId, () => {
    namingPreset.value = false;
    newPresetName.value = "";
});
</script>

<template>
    <fieldset id="prompt-enhancement-settings" class="settings__group">
        <legend>Prompt Enhancement</legend>
        <div class="settings__grid">
            <div class="field--full">
                <label for="enhance-base-url">API Base URL</label>
                <input id="enhance-base-url" v-model="enhancement.baseUrl" type="url" placeholder="https://your-api.example/v1" spellcheck="false" />
                <span class="hint">Use an OpenAI-compatible API base URL including its version path, or the full /chat/completions URL.</span>
            </div>
            <div class="field">
                <label for="enhance-api-key">API Key</label>
                <input id="enhance-api-key" v-model="enhancement.apiKey" type="password" autocomplete="off" placeholder="Optional for local APIs" />
            </div>
            <div class="field">
                <label for="enhance-model">Model</label>
                <input id="enhance-model" v-model="enhancement.model" placeholder="Model ID from your provider" spellcheck="false" />
            </div>
            <div class="field--full">
                <label for="enhance-system-prompt">System Prompt</label>
                <textarea id="enhance-system-prompt" v-model="enhancement.systemPrompt" rows="5" placeholder="Describe how to enhance the prompt. Ask for only the resulting prompt text." />
                <span class="hint">Used for every enhancement. Selecting a preset fills this field; editing it does not change the saved preset.</span>
            </div>
            <div class="field--full">
                <label for="enhance-preset">Preset (optional)</label>
                <select id="enhance-preset" :value="enhancement.activePresetId" @change="enhancement.selectPreset(($event.target as HTMLSelectElement).value)">
                    <option value="">Custom (no preset)</option>
                    <option v-for="preset in enhancement.presets" :key="preset.id" :value="preset.id">{{ preset.name || 'Untitled preset' }}</option>
                </select>
            </div>
            <div class="field--full">
                <div class="enhancement-actions">
                    <button ref="saveButton" class="btn-secondary" type="button" :disabled="!enhancement.systemPrompt.trim() || namingPreset" :aria-expanded="namingPreset" aria-controls="enhance-new-preset" @click="beginSavePreset">Save as new preset</button>
                    <button v-if="enhancement.activePreset" class="btn-secondary" type="button" :disabled="!enhancement.systemPrompt.trim() || !enhancement.presetModified" @click="enhancement.updatePreset">Update selected preset</button>
                    <button v-if="enhancement.activePreset" class="btn-ghost" type="button" @click="enhancement.removePreset">Delete preset</button>
                </div>
                <span v-if="enhancement.presetModified" class="hint" role="status">Current settings differ from the saved preset. Update it only if you want to keep these changes in the preset.</span>
            </div>
            <div v-if="namingPreset" id="enhance-new-preset" class="field--full" @keydown.esc.stop.prevent="cancelSavePreset">
                <label for="enhance-preset-name">Preset Name</label>
                <input id="enhance-preset-name" ref="nameInput" v-model="newPresetName" placeholder="Name this preset" @keydown.enter.prevent="!$event.isComposing && saveNewPreset()" />
                <div class="enhancement-actions">
                    <button class="btn-secondary" type="button" :disabled="!newPresetName.trim() || !enhancement.systemPrompt.trim()" @click="saveNewPreset">Save preset</button>
                    <button class="btn-ghost" type="button" @click="cancelSavePreset">Cancel</button>
                </div>
            </div>
        </div>
        <p class="hint">The current system prompt and API settings, including the API key, are saved in this browser automatically. Presets are saved only with the buttons above. Enhance sends your prompt and current system prompt directly to this API. The provider must allow browser requests (CORS).</p>
    </fieldset>
</template>

<style scoped>
.settings__grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.field { min-width: 0; }

@media (max-width: 720px) {
    .settings__grid { grid-template-columns: minmax(0, 1fr); }
}
</style>
