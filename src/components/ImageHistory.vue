<script setup lang="ts">
import { ref } from "vue";
import CollapsibleSection from "./CollapsibleSection.vue";
import type { ImageHistoryEntry } from "../lib/history";
import type { ImageOutput } from "../lib/types";

defineProps<{ entries: ImageHistoryEntry[] }>();
const emit = defineEmits<{
    (e: "preview", src: string, alt: string): void;
}>();
const expanded = ref<Record<string, boolean>>({});

function imageSrc(entry: ImageHistoryEntry, image: ImageOutput): string {
    return `data:image/${entry.outputFormat};base64,${image.b64_json}`;
}

function formatTime(seconds?: number): string {
    return seconds ? new Date(seconds * 1000).toLocaleString() : "Unknown time";
}

function additionalParameters(entry: ImageHistoryEntry): string {
    const { prompt, negative_prompt, ...parameters } = entry.parameters;
    return JSON.stringify({
        ...parameters,
        image_inputs: entry.inputs.map(({ label, files }) => ({ label, count: files.length, files })),
    }, null, 2);
}
</script>

<template>
    <section class="history-view" aria-label="Image history">
        <div class="panel history-card">
            <h2 class="panel-title">Image history ({{ entries.length }})</h2>
            <p class="hint">Completed images from this tab only. Refreshing or closing the page clears this history.</p>
            <p v-if="!entries.length" class="hint">No completed images yet.</p>
        </div>

        <article v-for="entry in entries" :key="entry.key" class="panel history-card">
            <div class="panel-header">
                <div class="history-heading">
                    <h3 class="history-model">{{ entry.model }}</h3>
                    <div class="hint">{{ formatTime(entry.created) }} · {{ entry.jobId }}</div>
                </div>
                <div class="hint history-summary">
                    {{ entry.parameters.width }} × {{ entry.parameters.height }}
                    · {{ entry.parameters.sample_params.sample_steps }} steps
                    · Seed {{ entry.parameters.seed === -1 ? '-1 (random requested)' : entry.parameters.seed }}
                </div>
            </div>

            <div class="history-images">
                <div v-for="image in entry.images" :key="image.index" class="history-image">
                    <button class="thumb history-thumb" type="button"
                        :aria-label="`View output ${image.index + 1} from ${entry.jobId}`"
                        @click="emit('preview', imageSrc(entry, image), `Output ${image.index + 1} from ${entry.jobId}`)">
                        <img :src="imageSrc(entry, image)" :alt="`Output ${image.index + 1}`" loading="lazy" />
                    </button>
                    <a class="btn-secondary history-download" :href="imageSrc(entry, image)"
                        :download="`${entry.jobId}-${image.index + 1}.${entry.outputFormat}`">Download</a>
                </div>
            </div>

            <CollapsibleSection class="stack-top" eyebrow="Submitted parameters"
                :open="Boolean(expanded[entry.key])" @toggle="expanded[entry.key] = !expanded[entry.key]">
                <p class="hint">Values sent when this job was submitted. Server-selected defaults and random seeds are not resolved here.</p>
                <div class="field--full">
                    <label>Prompt</label>
                    <p class="history-text">{{ entry.parameters.prompt }}</p>
                </div>
                <div class="field--full">
                    <label>Negative Prompt</label>
                    <p class="history-text">{{ entry.parameters.negative_prompt || 'None' }}</p>
                </div>
                <pre class="history-parameters">{{ additionalParameters(entry) }}</pre>
            </CollapsibleSection>
        </article>
    </section>
</template>
