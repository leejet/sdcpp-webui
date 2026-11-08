<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { Job } from "../lib/types";

const props = defineProps<{ job: Job; now: number }>();
const receivedAt = ref(Date.now());
watch(() => props.job, () => { receivedAt.value = Date.now(); });

const stages: Record<string, string> = {
    queued: "Queued",
    waiting: "Waiting for execution",
    preparing: "Preparing generation",
    conditioning: "Encoding prompt",
    sampling: "Sampling",
    vae_encode: "Encoding input images",
    vae_decode: "Decoding output",
    audio_decode: "Decoding audio",
    upscaling: "Upscaling",
    adetailer: "ADetailer",
    encoding: "Encoding output",
};
const details: Record<string, string> = {
    positive_prompt: "Positive prompt",
    negative_prompt: "Negative prompt",
    image_condition: "Image conditioning",
    extensions: "Preparing conditioning",
    inputs: "Preparing inputs",
    loras: "Preparing LoRAs",
    high_noise: "High noise",
    low_noise: "Low noise",
    hires: "High resolution",
    image: "Image",
    video: "Video",
};
const progress = computed(() => props.job.progress);
const running = computed(() => props.job.status === "queued" || props.job.status === "generating");
const stage = computed(() => props.job.status === "queued" ? "queued" : progress.value?.stage);
const label = computed(() => {
    if (!running.value) return ({ completed: "Completed", failed: "Failed", cancelled: "Cancelled" } as Record<string, string>)[props.job.status] || props.job.status;
    if (props.job.cancel_requested) return "Cancelling";
    return stage.value ? stages[stage.value] || stage.value : "Generating";
});
const detail = computed(() => {
    const value = progress.value?.detail;
    return value ? details[value] || stages[value] || value : "";
});
const total = computed(() => progress.value ? progress.value.total : props.job.preview?.total_steps);
const completed = computed(() => progress.value ? progress.value.completed : props.job.preview?.step);
const determinate = computed(() => total.value != null && total.value > 0 && completed.value != null);
const value = computed(() => determinate.value ? Math.max(0, Math.min(completed.value!, total.value!)) : undefined);
const percent = computed(() => determinate.value ? Math.floor(value.value! / total.value! * 100) : null);
const unit = computed(() => progress.value?.unit || "steps");
const pass = computed(() => {
    if (progress.value) {
        return progress.value.stage === "sampling" || progress.value.detail === "sampling" ? progress.value.pass : 0;
    }
    return props.job.preview?.pass || 0;
});
const stageElapsed = computed(() => {
    if (!progress.value) return null;
    const elapsed = progress.value.stage_elapsed_ms + (running.value ? Math.max(0, props.now - receivedAt.value) : 0);
    return (elapsed / 1000).toFixed(1);
});
const elapsed = computed(() => {
    const ms = props.job.started
        ? (props.job.completed || props.now) - props.job.started
        : (progress.value?.elapsed_ms || 0) + (running.value && stage.value !== "queued" ? Math.max(0, props.now - receivedAt.value) : 0);
    const seconds = Math.max(0, ms) / 1000;
    return seconds < 60 ? `${seconds.toFixed(1)}s` : `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
});
const description = computed(() => [label.value, detail.value, pass.value ? `Pass ${pass.value}` : "", stageElapsed.value !== null ? `${stageElapsed.value}s in this stage` : ""].filter(Boolean).join(" · "));
</script>

<template>
    <div class="generation-progress">
        <div class="generation-progress__summary">
            <span class="generation-progress__label" role="status" :title="description">{{ label }}</span>
            <div class="generation-progress__metrics">
                <span v-if="stage === 'queued' && running">Queue {{ job.queue_position ?? 0 }}</span>
                <template v-else-if="running && determinate">
                    <span :title="`${pass ? `Pass ${pass} · ` : ''}${completed} / ${total} ${unit}`">{{ completed }}/{{ total }}</span>
                    <span class="generation-progress__percent">{{ percent }}%</span>
                </template>
                <span title="Total generation time">{{ elapsed }}</span>
            </div>
            <slot name="actions" />
        </div>
        <progress :class="{ 'generation-progress__inactive': !running }" :value="value" :max="total && total > 0 ? total : 1" :aria-label="label" :aria-hidden="!running" />
    </div>
</template>

<style scoped>
.generation-progress { width: 100%; height: 40px; display: grid; grid-template-rows: 34px 3px; gap: 3px; color: var(--muted); font-size: 12px; line-height: 18px; font-variant-numeric: tabular-nums; }
.generation-progress__summary { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; align-items: center; gap: 12px; }
.generation-progress__label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text); }
.generation-progress__metrics { display: flex; gap: 12px; white-space: nowrap; }
.generation-progress__inactive { visibility: hidden; }
progress { display: block; width: 100%; height: 3px; margin: 0; border: 0; border-radius: 3px; overflow: hidden; accent-color: var(--primary); }
progress::-webkit-progress-bar { background: var(--border); }
progress::-webkit-progress-value { background: var(--primary); }
progress::-moz-progress-bar { background: var(--primary); }
@media (max-width: 720px) {
    .generation-progress__summary, .generation-progress__metrics { gap: 8px; }
    .generation-progress__percent { display: none; }
}
</style>
