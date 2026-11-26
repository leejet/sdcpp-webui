<script setup lang="ts">
import { computed, ref } from "vue";

const props = defineProps<{ beforeSrc: string; beforeLabel: string; resultSrc: string }>();
defineEmits<{ (event: "expand"): void }>();

const frame = ref<HTMLDivElement | null>(null);
const slider = ref<HTMLInputElement | null>(null);
const beforeLoaded = ref<string | null>(null);
const resultLoaded = ref<string | null>(null);
const ready = computed(() => beforeLoaded.value === props.beforeSrc && resultLoaded.value === props.resultSrc);
const split = ref(0);
const sliderValue = computed(() => Math.round(split.value));
const dragging = ref(false);

function loadedSource(event: Event): string | null {
    return (event.currentTarget as HTMLImageElement).getAttribute("src");
}

function startDrag(event: PointerEvent): void {
    if (!event.isPrimary || event.button !== 0) return;
    event.preventDefault();
    slider.value?.focus({ preventScroll: true });
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    dragging.value = true;
}

function moveDrag(event: PointerEvent): void {
    const target = event.currentTarget as HTMLElement;
    if (!frame.value || !target.hasPointerCapture(event.pointerId)) return;
    const { left, width } = frame.value.getBoundingClientRect();
    if (width > 0) split.value = Math.min(100, Math.max(0, (event.clientX - left) / width * 100));
}
</script>

<template>
    <div ref="frame" class="hero-frame image-compare" role="group" aria-label="Image comparison" :style="{ '--image-split': `${split}%` }"
        :class="{ 'image-compare--ready': ready, 'image-compare--at-edge': split === 0 || split === 100, 'image-compare--dragging': dragging }">
        <div class="image-compare__images">
            <img class="image-compare__before" :src="beforeSrc" :alt="beforeLabel" draggable="false" @load="beforeLoaded = loadedSource($event)" @error="beforeLoaded = null" />
            <img class="image-compare__result" :src="resultSrc" alt="Generated output" draggable="false" @load="resultLoaded = loadedSource($event)" @error="resultLoaded = null" />
        </div>
        <button class="image-compare__expand" type="button" aria-label="Expand generated output" aria-haspopup="dialog" @click="$emit('expand')"></button>
        <template v-if="ready">
            <span class="image-compare__line" aria-hidden="true"></span>
            <span class="image-compare__handle" aria-hidden="true"></span>
        </template>
        <div v-show="ready" class="image-compare__drag-area" @pointerdown="startDrag" @pointermove="moveDrag" @lostpointercapture="dragging = false">
            <input ref="slider" class="image-compare__slider" type="range" min="0" max="100" :value="sliderValue" aria-label="Comparison divider"
                :aria-valuetext="`${beforeLabel} ${sliderValue}%, result ${100 - sliderValue}%`"
                @input="split = ($event.currentTarget as HTMLInputElement).valueAsNumber" />
        </div>
    </div>
</template>

<style scoped>
.image-compare {
    --compare-gutter: 24px;
    --compare-hit-width: 36px;
    --compare-handle-size: 34px;
    position: relative;
    overflow: visible;
    isolation: isolate;
}
.image-compare__images,
.image-compare__expand { position: absolute; inset: 0; border-radius: inherit; }
.image-compare__images { overflow: hidden; pointer-events: none; }
.image-compare__images img { position: absolute; inset: 0; user-select: none; }
.image-compare__before { visibility: hidden; }
.image-compare--ready .image-compare__before { visibility: visible; clip-path: inset(0 calc(100% - var(--image-split)) 0 0); }
.image-compare--ready .image-compare__result { clip-path: inset(0 0 0 var(--image-split)); }
.image-compare__expand { border: 0; background: transparent; cursor: zoom-in; }
.image-compare__expand:focus-visible { outline: 2px solid var(--primary); outline-offset: -3px; }
.image-compare__line,
.image-compare__handle {
    position: absolute;
    top: 50%;
    left: var(--image-split);
    transform: translate(-50%, -50%);
    background: #fff;
    box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.45);
    pointer-events: none;
}
.image-compare__line { width: 2px; height: 100%; }
.image-compare--at-edge .image-compare__line { visibility: hidden; }
.image-compare__handle {
    visibility: hidden;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 3px;
    width: var(--compare-handle-size);
    height: var(--compare-handle-size);
    border-radius: 50%;
    color: #242424;
}
.image-compare__handle::before,
.image-compare__handle::after {
    content: "";
    width: 5px;
    height: 5px;
    border: solid currentColor;
    border-width: 0 2px 2px 0;
    rotate: 135deg;
}
.image-compare__handle::after { rotate: -45deg; }
.image-compare__drag-area {
    position: absolute;
    top: 0;
    left: clamp(calc(-1 * var(--compare-gutter)), calc(var(--image-split) - var(--compare-hit-width) / 2), calc(100% + var(--compare-gutter) - var(--compare-hit-width)));
    width: min(var(--compare-hit-width), calc(100% + 2 * var(--compare-gutter)));
    height: 100%;
    cursor: ew-resize;
    touch-action: pan-y;
}
.image-compare__slider {
    box-sizing: border-box;
    width: 100%;
    height: 100%;
    margin: 0;
    padding: 0;
    opacity: 0;
    pointer-events: none;
}
.image-compare--dragging .image-compare__handle,
.image-compare:has(.image-compare__drag-area:hover, .image-compare__slider:focus-visible) .image-compare__handle { visibility: visible; }
.image-compare:has(.image-compare__slider:focus-visible) .image-compare__handle {
    outline: 2px solid var(--primary);
    outline-offset: -2px;
}
@media (max-width: 720px) {
    .image-compare { --compare-gutter: 12px; --compare-handle-size: 22px; }
}
@media (pointer: coarse) {
    .image-compare { --compare-hit-width: 44px; }
}
@media (hover: none) {
    .image-compare__handle { visibility: visible; }
}
</style>
