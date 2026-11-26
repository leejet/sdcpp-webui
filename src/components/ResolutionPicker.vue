<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { ASPECT_RATIOS, alignDimension, alignDimensions, aspectLabel, dimensionError, dimensionsForResolution, resolutionPresets } from "../lib/resolution";
import type { Dimensions } from "../lib/resolution";
import type { Capabilities, GenerationMode } from "../lib/types";

const props = defineProps<{
    width: number;
    height: number;
    mode: GenerationMode;
    limits?: Capabilities["limits"];
    sizeMultiple: number;
    recommended: Dimensions;
}>();
const emit = defineEmits<{ (event: "change", size: Dimensions): void }>();
const locked = ref(false);
const ratio = ref(1);
const tier = ref("custom");
const ratioError = ref("");
let pendingSize: Dimensions | null = null;
const size = computed(() => ({ width: props.width, height: props.height }));
const error = computed(() => dimensionError(size.value, props.limits, props.sizeMultiple));
const recommendedSize = computed(() => alignDimensions(props.recommended, props.sizeMultiple));
const selectedTier = computed(() => {
    if (tier.value === "model-default" && (props.width !== recommendedSize.value.width || props.height !== recommendedSize.value.height)) return "custom";
    return tier.value;
});
const correctedSize = computed(() => {
    if (!(props.width > 0 && props.height > 0)) return null;
    const next = alignDimensions(size.value, props.sizeMultiple);
    return error.value && !dimensionError(next, props.limits, props.sizeMultiple) ? next : null;
});
const presets = computed(() => resolutionPresets(props.mode));
const presetSizes = computed(() => presets.value.map((preset) => ({
    ...preset,
    size: dimensionsForResolution(ratio.value, preset.value, props.mode, props.sizeMultiple),
})));

watch(() => [props.width, props.height, props.mode, props.sizeMultiple] as const, ([width, height], previous) => {
    if (pendingSize?.width === width && pendingSize?.height === height && previous?.[2] === props.mode && previous?.[3] === props.sizeMultiple) {
        pendingSize = null;
        return;
    }
    pendingSize = null;
    tier.value = "custom";
    if (width > 0 && height > 0) {
        ratio.value = width / height;
        const matchingPreset = presets.value.find((preset) => {
            const candidate = dimensionsForResolution(ratio.value, preset.value, props.mode, props.sizeMultiple);
            return candidate.width === width && candidate.height === height;
        });
        tier.value = matchingPreset?.id || "custom";
    }
}, { immediate: true });

function commit(next: Dimensions, nextTier = "custom"): void {
    ratioError.value = "";
    tier.value = nextTier;
    pendingSize = next;
    emit("change", next);
}

function chooseRatio(value: number): void {
    ratioError.value = "";
    const preset = presets.value.find((item) => item.id === tier.value);
    const scale = preset?.value ?? (props.mode === "image" ? props.width * props.height : Math.min(props.width, props.height));
    const next = dimensionsForResolution(value, scale, props.mode, props.sizeMultiple);
    const invalid = dimensionError(next, props.limits, props.sizeMultiple);
    if (invalid) { ratioError.value = invalid; return; }
    ratio.value = value;
    locked.value = true;
    commit(next, preset?.id);
}

function choosePreset(id: string): void {
    const preset = presetSizes.value.find((item) => item.id === id);
    if (!preset || dimensionError(preset.size, props.limits, props.sizeMultiple)) return;
    commit(preset.size, id);
}

function editDimension(axis: "width" | "height", event: Event): void {
    const value = (event.target as HTMLInputElement).valueAsNumber;
    const next = { ...size.value, [axis]: value };
    if (locked.value && Number.isFinite(value) && value > 0) {
        if (axis === "width") next.height = alignDimension(value / ratio.value, props.sizeMultiple);
        else next.width = alignDimension(value * ratio.value, props.sizeMultiple);
    } else if (!locked.value && next.width > 0 && next.height > 0) {
        ratio.value = next.width / next.height;
    }
    commit(next);
}

function swap(): void {
    ratio.value = 1 / ratio.value;
    const nextTier = tier.value === "model-default" && props.width !== props.height ? "custom" : tier.value;
    commit({ width: props.height, height: props.width }, nextTier);
}

function recommend(): void {
    ratio.value = recommendedSize.value.width / recommendedSize.value.height;
    commit(recommendedSize.value, "model-default");
}

function correctSize(): void {
    if (!correctedSize.value) return;
    const next = correctedSize.value;
    if (!locked.value) ratio.value = next.width / next.height;
    commit(next);
}
</script>

<template>
    <section aria-labelledby="aspect-ratio-heading">
        <div class="resolution-heading"><h3 id="aspect-ratio-heading">Aspect Ratio</h3></div>
        <div class="ratio-options">
            <button v-for="item in ASPECT_RATIOS" :key="item.label" class="ratio-option" type="button"
                :aria-pressed="Math.abs(ratio / item.value - 1) < 0.005" @click="chooseRatio(item.value)">
                <span class="ratio-option__shape" :style="{ width: `${28 * Math.min(item.value, 1)}px`, height: `${28 / Math.max(item.value, 1)}px` }" aria-hidden="true"></span>
                <span>{{ item.label }}</span>
            </button>
        </div>
        <p v-if="ratioError" class="status-message status-message--error" role="alert">{{ ratioError }}</p>
        <p class="hint">Changing the ratio keeps {{ mode === 'image' ? 'approximately the same pixel area' : 'the same short-edge resolution' }}.</p>
    </section>
    <section aria-labelledby="resolution-heading">
        <div class="resolution-heading"><h3 id="resolution-heading">Resolution</h3></div>
        <div class="resolution-options">
            <button class="resolution-option" type="button" :aria-pressed="selectedTier === 'model-default'" :disabled="Boolean(dimensionError(recommendedSize, limits, sizeMultiple))" @click="recommend">
                <strong>Model default</strong><span>{{ recommendedSize.width }} × {{ recommendedSize.height }}</span>
            </button>
            <button v-for="preset in presetSizes" :key="preset.id" class="resolution-option" type="button"
                :aria-pressed="selectedTier === preset.id" :disabled="Boolean(dimensionError(preset.size, limits, sizeMultiple))" @click="choosePreset(preset.id)">
                <strong>{{ preset.label }}</strong><span>{{ preset.size.width }} × {{ preset.size.height }}</span>
            </button>
        </div>
        <p class="hint">{{ mode === 'image' ? 'Image tiers use a pixel budget; dimensions follow the aspect ratio.' : 'Video tiers set the short edge in pixels, including portrait video.' }}</p>
        <div class="resolution-heading"><h3>Exact dimensions <span v-if="selectedTier === 'custom'">· Custom</span></h3><button class="btn-ghost" type="button" :aria-pressed="locked" @click="locked = !locked">{{ locked ? 'Ratio locked' : 'Ratio unlocked' }}</button></div>
        <div class="fields">
            <div class="field"><label for="output-width">Width (px)</label><input id="output-width" :value="width" type="number" :min="alignDimension(limits?.min_width ?? 64, sizeMultiple)" :max="limits?.max_width ?? 4096" :step="sizeMultiple" @input="editDimension('width', $event)" /></div>
            <div class="field"><label for="output-height">Height (px)</label><input id="output-height" :value="height" type="number" :min="alignDimension(limits?.min_height ?? 64, sizeMultiple)" :max="limits?.max_height ?? 4096" :step="sizeMultiple" @input="editDimension('height', $event)" /></div>
        </div>
        <button class="btn-secondary stack-top" type="button" @click="swap">Swap width & height</button>
        <p v-if="error" class="status-message status-message--error" role="alert">{{ error }}</p>
        <button v-if="correctedSize" class="btn-secondary stack-top" type="button" @click="correctSize">Use {{ correctedSize.width }} × {{ correctedSize.height }}</button>
    </section>
    <p v-if="!error" class="resolution-summary">Requested: {{ width }} × {{ height }} · {{ aspectLabel(size, sizeMultiple) }} · {{ (width * height / 1e6).toFixed(2) }} MP</p>
    <p class="hint">Width and height use multiples of {{ sizeMultiple }} px. Larger sizes require more memory.</p>
</template>
