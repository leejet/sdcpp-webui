<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, toRef, watch } from "vue";

import PromptComposer from "./components/PromptComposer.vue";
import PromptEnhancementSettings from "./components/PromptEnhancementSettings.vue";
import ReferenceInputs from "./components/ReferenceInputs.vue";
import brandSvg from "../icon-preview.svg?raw";
import { dimensionError, sizeMultiple } from "./lib/resolution";
import { useVideoLength } from "./lib/video-length";
import CollapsibleSection from "./components/CollapsibleSection.vue";
import ModelSelector from "./components/ModelSelector.vue";
import SearchableSelect from "./components/SearchableSelect.vue";
import MediaDropzone from "./components/MediaDropzone.vue";
import StatusChip from "./components/StatusChip.vue";
import GenerationProgress from "./components/GenerationProgress.vue";
import { cancelJob, getCapabilities, getJob, submitImageJob, submitVideoJob } from "./lib/api";
import { applyRecipeDefaults, buildRequestBodyForMode, createBlankForm, formFromCapabilities } from "./lib/form";
import { availableCacheModes, featuresForMode, supportsEta, supportsFlowShift, usesSCM } from "./lib/generation-features";
import { assignImageEntries, clearImageEntries, filesToImageEntries, removeImageEntry } from "./lib/images";
import { createStoredRef, normalizePollIntervalMs, normalizePreviewInterval } from "./lib/settings";
import { getNotificationPermission, isNotificationSupported, requestNotificationPermission, sendBrowserNotification } from "./lib/notifications";
import { useLoraSelection } from "./lib/lora-selection";
import { useTheme } from "./lib/theme";
import { useMediaInput } from "./lib/media-input";
import { usePromptEnhancement } from "./lib/prompt-enhancement";
import type {
    Capabilities,
    ModelStatus,
    Recipe,
    GenerationForm,
    GenerationFeatures,
    GenerationMode,
    ImageEntry,
    ImageTarget,
    Job,
    SampleParams,
    FormLoraEntry,
} from "./lib/types";

const brandIcon = `data:image/svg+xml,${encodeURIComponent(brandSvg)}`;
const baseUrl = createStoredRef<string>("sdcpp-webui-base-url", "", (value: unknown) => String(value || ""));
const pollIntervalMs = createStoredRef<number>("sdcpp-webui-poll-interval-ms", 100, normalizePollIntervalMs);
const preferredPreviewMode = createStoredRef<string>("sdcpp-webui-preview-mode", "none", (value: unknown) => typeof value === "string" ? value : "none");
const previewInterval = createStoredRef<number>("sdcpp-webui-preview-interval", 1, normalizePreviewInterval);
const notifyOnCompletion = createStoredRef<boolean>("sdcpp-webui-notify-on-completion", false, (value: unknown) => typeof value === "boolean" ? value : false);
const notificationPermission = ref<NotificationPermission | "unsupported">(getNotificationPermission());
const notificationSupported = computed(() => isNotificationSupported());
const notificationStatusMessage = computed(() => {
    if (!notificationSupported.value || notificationPermission.value === "unsupported") {
        return "Browser notifications are not supported in this browser.";
    }
    if (!notifyOnCompletion.value) {
        return "Enable to get a browser notification when generation finishes, even if the tab is in the background.";
    }
    if (notificationPermission.value === "granted") {
        return "You will be notified when generation finishes.";
    }
    if (notificationPermission.value === "denied") {
        return "Notifications are blocked. Allow notifications for this site in your browser settings, then enable this option again.";
    }
    return "Browser permission is needed before notifications can be shown.";
});
const settingsOpen = ref(false);
const { theme, resolvedTheme, toggleTheme } = useTheme();
const themeToggleLabel = computed(() => resolvedTheme.value === "dark" ? "Switch to light mode" : "Switch to dark mode");
const generationMode = ref<GenerationMode>("image");
const lightboxOpen = ref(false);
const generationDetails = ref<HTMLDialogElement | null>(null);
const lightboxImageSrc = ref("");
const lightboxImageAlt = ref("");
let lightboxTrigger: HTMLElement | null = null;
const sectionState = reactive<Record<string, boolean>>({
    sampleAdvanced: false,
    guidance: true,
    guidanceAdvanced: false,
    highNoise: false,
    highNoiseSample: true,
    highNoiseGuidance: true,
    conditioning: false,
    imageSettings: true,
    referenceMedia: true,
    cache: false,
});
const loadingCapabilities = ref(false);
const capabilitiesError = ref("");
const serviceOnline = ref(false);
const capabilities = ref<Capabilities | null>(null);
const modelStatus = ref<ModelStatus | null>(null);
const selectedRecipe = ref<Recipe | null>(null);
const dimensionMultiple = computed(() => sizeMultiple(selectedRecipe.value?.size_multiple));
const applyRecipeDefaultsOnSelect = createStoredRef<boolean>("sdcpp-webui-apply-recipe-defaults", true, (value: unknown) => typeof value === "boolean" ? value : true);
const modelSelection = ref<Record<string, string>>({});
const modelReady = computed(() => modelStatus.value ? modelStatus.value.state === "ready" : Boolean(capabilities.value?.model?.name));
const currentJob = ref<Job | null>(null);
const selectedOutputIndex = ref(0);
const submittedAspectRatio = ref<number | null>(null);
const statusMessage = ref("");
const statusTone = ref("");
const cancelling = ref(false);
let pollVersion = 0;
const form = reactive<GenerationForm>(createBlankForm());
const enhancement = usePromptEnhancement(toRef(form, "prompt"), generationMode);
const videoConstraints = computed(() => selectedRecipe.value?.video_constraints);
const videoLength = reactive(useVideoLength(form, videoConstraints));
const composer = ref<InstanceType<typeof PromptComposer> | null>(null);
const modeDrafts = new Map<GenerationMode, GenerationForm>();
const videoInput = useMediaInput("video", toRef(form, "ref_video"));
const audioInput = useMediaInput("audio", toRef(form, "ref_audio"));
const submitting = ref(false);
const outputAspectRatio = computed(() => {
    if (currentJob.value && submittedAspectRatio.value !== null) return submittedAspectRatio.value;
    const ratio = Number(form.width) / Number(form.height);
    return Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
});

let pollTimer = 0;
let elapsedTimer = 0;
const nowMilliseconds = ref(Date.now());

const modelName = computed(() => {
    const model = capabilities.value?.model;
    return model?.stem || model?.name || "No model loaded";
});

const supportedModes = computed(() => capabilities.value?.supported_modes || []);
const loadedRecipeId = computed(() => modelStatus.value?.runtime_recipe?.id || modelStatus.value?.recipe);
const loras = useLoraSelection(baseUrl, computed(() => selectedRecipe.value?.id || loadedRecipeId.value || undefined));
const recipeMode = computed<GenerationMode>(() => {
    if (selectedRecipe.value && selectedRecipe.value.source !== "command_line") {
        return selectedRecipe.value.defaults?.video_frames !== undefined ? "video" : "image";
    }
    const mode = capabilities.value?.current_mode || (supportedModes.value.length === 1 ? supportedModes.value[0] : "img_gen");
    return mode === "vid_gen" ? "video" : "image";
});
const previewingRecipe = computed(() => Boolean(selectedRecipe.value) &&
    (!modelReady.value || loadedRecipeId.value !== selectedRecipe.value?.id));
const selectedModeKey = computed<"img_gen" | "vid_gen">(() => generationMode.value === "video" ? "vid_gen" : "img_gen");
const canGenerate = computed(() => modelReady.value && !previewingRecipe.value &&
    (!supportedModes.value.length || supportedModes.value.includes(selectedModeKey.value)));
const currentJobModeKey = computed<"img_gen" | "vid_gen">(() => currentJob.value?.kind || selectedModeKey.value);
const selectedModeFeatures = computed(() => {
    return capabilities.value?.features_by_mode?.[selectedModeKey.value] || {};
});
const currentJobFeatures = computed(() => {
    return capabilities.value?.features_by_mode?.[currentJobModeKey.value] || selectedModeFeatures.value;
});
const imageOutputFormats = computed(() => {
    return capabilities.value?.output_formats_by_mode?.img_gen || ["png", "jpeg"];
});
const videoOutputFormats = computed(() => {
    return capabilities.value?.output_formats_by_mode?.vid_gen || ["webm", "avi"];
});
const outputFormats = computed(() => generationMode.value === "video" ? videoOutputFormats.value : imageOutputFormats.value);
const samplers = computed(() => capabilities.value?.samplers || ["default"]);
const schedulers = computed(() => capabilities.value?.schedulers || ["default"]);
const availableLoras = computed(() => capabilities.value?.loras || []);
const generationFeatures = computed<GenerationFeatures>(() => {
    const loadedSelection = !previewingRecipe.value && loadedRecipeId.value === selectedRecipe.value?.id;
    const declared = loadedSelection ? capabilities.value?.generation_features : selectedRecipe.value?.effective_features;
    const features = { ...(declared || capabilities.value?.generation_features || {}) };
    if (selectedRecipe.value && selectedRecipe.value.source !== "command_line") {
        for (const [feature, slots] of Object.entries({ high_noise: ["high_noise_diffusion_model"], preview_tae: ["tae", "taesd"] })) {
            features[feature] = Boolean(features[feature] && slots.some((slot) => modelSelection.value[slot]));
        }
        if (modelSelection.value.pulid_weights) features.slg = false;
    }
    return featuresForMode(features, generationMode.value);
});
const hasFeature = (name: string): boolean => Boolean(generationFeatures.value[name]);
const mediaProcessing = computed(() => (hasFeature("ref_videos") && form.ref_video?.processing) ||
    (hasFeature("ref_audios") && form.ref_audio?.processing));
const mediaSummary = computed(() => [hasFeature("ref_videos") && form.ref_video ? "1 video" : "",
    hasFeature("ref_audios") && form.ref_audio ? "1 audio" : ""].filter(Boolean).join(" · ") || "No media");
const sampleHasEta = (sample: SampleParams): boolean => supportsEta(sample.sample_method, generationFeatures.value);
const sampleHasFlowShift = (sample: SampleParams): boolean => supportsFlowShift(sample.scheduler, generationFeatures.value);
const sampleHasExtras = (sample: SampleParams): boolean => sampleHasEta(sample) || hasFeature("shifted_timestep");
const hasGuidanceExtras = computed(() => hasFeature("img_cfg") || hasFeature("slg"));
const hasConditioning = computed(() => ["clip_skip", "controlnet", "vace"].some(hasFeature));
const cacheModes = computed(() => availableCacheModes(generationFeatures.value));
const recommendedDimensions = computed(() => {
    const defaults = capabilities.value?.defaults_by_mode?.[selectedModeKey.value] || {};
    const recipeDefaults = recipeMode.value === generationMode.value ? selectedRecipe.value?.defaults : undefined;
    return {
        width: recipeDefaults?.width ?? defaults.width ?? 512,
        height: recipeDefaults?.height ?? defaults.height ?? 512,
    };
});
const queueLimit = computed(() => capabilities.value?.limits?.max_queue_size ?? "unknown");
const canCancelQueued = computed(() => Boolean(currentJobFeatures.value.cancel_queued));
const canCancelGenerating = computed(() => Boolean(currentJobFeatures.value.cancel_generating));
const supportsPreview = computed(() => hasFeature("preview"));
const previewModes = computed(() => capabilities.value?.preview_modes || ["none", "proj", "tae", "vae"]);
const previewMode = computed(() => supportsPreview.value && previewModes.value.includes(preferredPreviewMode.value) &&
    (preferredPreviewMode.value !== "tae" || hasFeature("preview_tae")) ? preferredPreviewMode.value : "none");

const currentStatus = computed(() => currentJob.value?.status || "idle");
const currentJobKind = computed(() => currentJob.value?.kind || null);
const currentImages = computed(() => currentJobKind.value === "img_gen" ? currentJob.value?.result?.images || [] : []);
const selectedImage = computed(() => {
    if (!currentImages.value.length) {
        return null;
    }
    const index = Math.min(selectedOutputIndex.value, currentImages.value.length - 1);
    const image = currentImages.value[index];
    const format = currentJob.value?.result?.output_format || form.output_format || "png";
    return `data:image/${format};base64,${image.b64_json}`;
});
const videoMimeType = computed(() => currentJobKind.value === "vid_gen" ? currentJob.value?.result?.mime_type || "" : "");
const videoFrameCount = computed(() => currentJobKind.value === "vid_gen" ? currentJob.value?.result?.frame_count || 0 : 0);
const videoFps = computed(() => currentJobKind.value === "vid_gen" ? currentJob.value?.result?.fps || 0 : 0);
const videoPreviewSrc = computed(() => {
    if (currentJobKind.value !== "vid_gen" || !currentJob.value?.result?.b64_json) {
        return null;
    }
    if (currentJob.value?.result?.output_format === "avi") {
        return null;
    }
    if (!videoMimeType.value.startsWith("video/")) {
        return null;
    }
    return `data:${videoMimeType.value};base64,${currentJob.value.result.b64_json}`;
});
const animatedVideoImageSrc = computed(() => {
    if (currentJobKind.value !== "vid_gen" || !currentJob.value?.result?.b64_json) {
        return null;
    }
    if (videoMimeType.value !== "image/webp") {
        return null;
    }
    return `data:image/webp;base64,${currentJob.value.result.b64_json}`;
});
const previewImageSrc = computed(() => animatedVideoImageSrc.value || selectedImage.value);
const livePreviewSrc = computed(() => {
    if (currentStatus.value !== "generating" || !currentJob.value?.preview?.b64_json) {
        return null;
    }
    return `data:image/png;base64,${currentJob.value.preview.b64_json}`;
});
const downloadableSrc = computed(() => {
    const result = currentJob.value?.result;
    if (currentJobKind.value === "vid_gen" && result?.b64_json && videoMimeType.value) {
        return `data:${videoMimeType.value};base64,${result.b64_json}`;
    }
    return selectedImage.value;
});

const canCancelCurrentJob = computed(() => {
    if (!currentJob.value || cancelling.value || currentJob.value.cancel_requested) {
        return false;
    }
    if (currentStatus.value === "queued") {
        return canCancelQueued.value;
    }
    if (currentStatus.value === "generating") {
        return canCancelGenerating.value;
    }
    return false;
});

const isJobRunning = computed(() => {
    return currentStatus.value === "queued" || currentStatus.value === "generating";
});

function buildSampleSummary(sample: SampleParams): string {
    const scheduler = sample.scheduler || "default";
    const method = sample.sample_method || "default";
    const steps = sample.sample_steps || 0;
    const flowShift = sample.flow_shift === "" || sample.flow_shift == null
        ? "flow auto"
        : `flow ${sample.flow_shift}`;
    return [scheduler, ...(sampleHasFlowShift(sample) ? [flowShift] : []), method, `${steps} steps`].join(" · ");
}

function buildGuidanceSummary(sample: SampleParams): string {
    const cfg = sample.guidance.txt_cfg;
    const distilled = sample.guidance.distilled_guidance;
    return `cfg ${cfg}` + (hasFeature("distilled_guidance") ? ` · distilled ${distilled}` : "");
}

const sampleSummary = computed(() => buildSampleSummary(form.sample_params));
const guidanceSummary = computed(() => buildGuidanceSummary(form.sample_params));
const highNoiseSummary = computed(() => {
    return `moe ${formatSummaryNumber(form.moe_boundary)} · ${buildSampleSummary(form.high_noise_sample_params)} · ${buildGuidanceSummary(form.high_noise_sample_params)}`;
});
function loraInactiveReason(item: FormLoraEntry): string {
    if (!item.path.trim()) return "";
    if (!hasFeature("lora")) return "Inactive: this model does not support LoRA.";
    if (item.is_high_noise && !hasFeature("high_noise")) return "Inactive: this model has no high-noise stage.";
    if (capabilities.value && !availableLoras.value.some((lora) => lora.path === item.path)) return "Inactive: file not found. Select another LoRA or refresh files.";
    return "";
}
const showLoras = computed(() => hasFeature("lora") || loras.value.length > 0);
const showLoraHighNoise = computed(() => hasFeature("high_noise") || loras.value.some((item) => item.is_high_noise));
const loraSummary = computed(() => {
    const configured = loras.value.filter((item) => item.path.trim());
    const inactive = configured.filter((item) => loraInactiveReason(item)).length;
    return configured.length ? `${configured.length} LoRA${configured.length === 1 ? "" : "s"}${inactive ? ` (${inactive} inactive)` : ""}` : "No LoRA";
});
const loraOptions = computed(() => [
    ...availableLoras.value.map((lora) => ({ value: lora.path, label: lora.display_path || lora.path })),
    ...[...new Set(loras.value.map((item) => item.path).filter((path) => path && !availableLoras.value.some((lora) => lora.path === path)))].map((path) => ({ value: path, label: `${path} (unavailable)` })),
]);
const imageSettingsSummary = computed(() => {
    const parts: string[] = [];
    if (hasFeature("init_image") && hasFeature("img2img") && form.init_image) parts.push(`Denoising ${formatSummaryNumber(form.strength)}`);
    if (hasFeature("ip_adapter_image")) parts.push(`IP-Adapter ${formatSummaryNumber(form.ip_adapter_strength)}`);
    return parts.join(" · ");
});
const cacheSummary = computed(() => {
    const mode = form.cache.mode || "disabled";
    if (mode === "disabled") {
        return "Disabled";
    }
    const option = String(form.cache.option || "").trim();
    return option ? `${mode} · ${option}` : mode;
});
const conditioningSummary = computed(() => {
    const parts: string[] = [];
    if (hasFeature("clip_skip")) parts.push(`clip_skip ${formatSummaryNumber(form.clip_skip, 0)}`);
    if (hasFeature("controlnet")) parts.push(`control ${formatSummaryNumber(form.control_strength)}`);
    if (hasFeature("vace")) parts.push(`vace ${formatSummaryNumber(form.vace_strength)}`);
    return parts.join(" · ");
});

function defaultOutputFormatForMode(mode: GenerationMode): string {
    if (mode === "video") {
        return videoOutputFormats.value[0] || "webm";
    }
    return imageOutputFormats.value[0] || "png";
}

function ensureOutputFormatForMode(mode = generationMode.value): void {
    const validFormats = mode === "video" ? videoOutputFormats.value : imageOutputFormats.value;
    if (!validFormats.length) {
        return;
    }
    if (!validFormats.includes(form.output_format)) {
        form.output_format = defaultOutputFormatForMode(mode);
    }
}

function setMessage(message: string, tone = ""): void {
    statusMessage.value = message;
    statusTone.value = tone;
}

function randomizeSeed(): void {
    form.seed = crypto.getRandomValues(new Uint32Array(1))[0];
}

function clearMessage(): void {
    setMessage("", "");
}

function deepAssign(target: Record<string, any>, ...sources: Record<string, any>[]): Record<string, any> {
    for (const source of sources) {
        if (!source) continue;
        for (const key of Object.keys(source)) {
            const sv = source[key];
            if (sv !== null && typeof sv === "object" && !Array.isArray(sv) &&
                target[key] !== null && typeof target[key] === "object" && !Array.isArray(target[key])) {
                deepAssign(target[key], sv);
            } else {
                target[key] = sv;
            }
        }
    }
    return target;
}

function applyForm(nextForm: GenerationForm): void {
    deepAssign(form, createBlankForm(), nextForm);
}

function updateCatalogRecipe(recipe: Recipe | null): void {
    if (selectedRecipe.value) {
        selectedRecipe.value = recipe;
        syncGenerationMode(recipeMode.value);
    }
    else if (recipe && (recipe.source === "command_line" || (!modelReady.value && modelStatus.value?.state !== "loading"))) selectRecipe(recipe);
    else if (recipe && recipe.id === loadedRecipeId.value) {
        selectedRecipe.value = recipe;
        syncGenerationMode(recipeMode.value);
    }
}

function selectRecipe(recipe: Recipe): void {
    selectedRecipe.value = recipe;
    syncGenerationMode(recipeMode.value);
    if (applyRecipeDefaultsOnSelect.value) {
        if (recipe.source === "command_line" && capabilities.value?.runtime?.origin === "command_line") {
            const defaults = formFromCapabilities(capabilities.value);
            for (const key of ["width", "height", "video_frames", "fps", "strength"] as const) form[key] = defaults[key];
            deepAssign(form.sample_params, defaults.sample_params);
            deepAssign(form.high_noise_sample_params, defaults.high_noise_sample_params);
        } else {
            applyRecipeDefaults(form, recipe.defaults);
        }
    }
    if (applyRecipeDefaultsOnSelect.value) videoLength.resetDuration();
    ensureOutputFormatForMode(recipeMode.value);
}

async function refreshCapabilities(): Promise<void> {
    loadingCapabilities.value = true;
    capabilitiesError.value = "";
    try {
        const response = await getCapabilities(baseUrl.value);
        const initializeForm = !capabilities.value;
        const enteringCommandLine = response.runtime?.origin === "command_line" && capabilities.value?.runtime?.origin !== "command_line";
        capabilities.value = response;
        if (response.runtime) modelStatus.value = response.runtime;
        serviceOnline.value = true;
        syncGenerationMode(recipeMode.value);
        if (initializeForm) {
            const defaults = formFromCapabilities(response);
            defaults.prompt = form.prompt || defaults.prompt;
            defaults.negative_prompt = form.negative_prompt || defaults.negative_prompt;
            applyForm(defaults);
            if (selectedRecipe.value && applyRecipeDefaultsOnSelect.value) applyRecipeDefaults(form, selectedRecipe.value.defaults);
            videoLength.resetDuration();
        }
        if (response.runtime?.runtime_recipe && (enteringCommandLine || !selectedRecipe.value)) {
            selectRecipe(response.runtime.runtime_recipe);
        }
        ensureOutputFormatForMode();
        clearMessage();
    } catch (error) {
        capabilitiesError.value = error instanceof Error ? error.message : String(error);
        serviceOnline.value = false;
        setMessage(capabilitiesError.value, "error");
    } finally {
        loadingCapabilities.value = false;
    }
}

function toggleSection(section: string): void {
    sectionState[section] = !sectionState[section];
}

function syncGenerationMode(mode: GenerationMode): void {
    if (mode !== generationMode.value) {
        modeDrafts.set(generationMode.value, { ...form });
        const draft = modeDrafts.get(mode) || formFromCapabilities({ ...capabilities.value, current_mode: mode === "video" ? "vid_gen" : "img_gen" });
        // Media decoding owns object URLs; keep video/audio references alive across mode switches.
        Object.assign(form, draft, { ref_video: form.ref_video, ref_audio: form.ref_audio });
        if (mode === "video" && !modeDrafts.has(mode)) videoLength.resetDuration();
    }
    generationMode.value = mode;
    ensureOutputFormatForMode(mode);
}

function openSettings(): void {
    refreshNotificationPermission();
    composer.value?.close();
    settingsOpen.value = !settingsOpen.value;
}

async function onNotifyToggle(): Promise<void> {
    if (notifyOnCompletion.value) {
        await ensureNotificationPermission();
    }
}

async function openEnhancementSettings(): Promise<void> {
    composer.value?.close();
    settingsOpen.value = true;
    await nextTick();
    document.getElementById("enhance-base-url")?.focus();
}

function stopPolling(): void {
    if (pollTimer) {
        window.clearTimeout(pollTimer);
        pollTimer = 0;
    }
}

function stopElapsedTimer(): void {
    if (elapsedTimer) {
        window.clearInterval(elapsedTimer);
        elapsedTimer = 0;
    }
}

function startElapsedTimer(): void {
    stopElapsedTimer();
    nowMilliseconds.value = Date.now();
    elapsedTimer = window.setInterval(() => {
        nowMilliseconds.value = Date.now();
    }, 100);
}

function refreshNotificationPermission(): void {
    notificationPermission.value = getNotificationPermission();
}

async function ensureNotificationPermission(): Promise<void> {
    if (!notifyOnCompletion.value || !notificationSupported.value) {
        return;
    }
    notificationPermission.value = await requestNotificationPermission();
}

function notifyJobFinished(status: string, kind: string | null, errorMessage?: string): void {
    if (!notifyOnCompletion.value || !notificationSupported.value || notificationPermission.value !== "granted") {
        return;
    }
    const isVideo = kind === "vid_gen";
    if (status === "completed") {
        sendBrowserNotification(isVideo ? "Video generation completed" : "Image generation completed", {
            body: isVideo ? "Your video is ready." : "Your image is ready.",
            tag: currentJob.value?.id,
        });
    } else if (status === "failed") {
        sendBrowserNotification("Generation failed", {
            body: errorMessage || "Generation failed.",
            tag: currentJob.value?.id,
        });
    } else if (status === "cancelled") {
        sendBrowserNotification("Generation cancelled", {
            body: "The generation job was cancelled.",
            tag: currentJob.value?.id,
        });
    }
}

async function pollJob(id: string): Promise<void> {
    stopPolling();
    const version = ++pollVersion;
    try {
        const job = await getJob(baseUrl.value, id);
        if (version !== pollVersion) return;
        currentJob.value = job;
        serviceOnline.value = true;
        if (currentStatus.value === "queued" || currentStatus.value === "generating") {
            pollTimer = window.setTimeout(() => pollJob(id), normalizePollIntervalMs(pollIntervalMs.value));
            if (job.cancel_requested) {
                setMessage("Cancellation requested. Waiting for generation to stop.", "");
            } else {
                clearMessage();
            }
            return;
        }
        stopElapsedTimer();
        if (currentStatus.value === "completed") {
            setMessage(currentJob.value?.kind === "vid_gen" ? "Video generation completed." : "Image generation completed.", "success");
            notifyJobFinished("completed", currentJob.value?.kind || null);
            return;
        }
        if (currentStatus.value === "cancelled") {
            setMessage("Job cancelled.", "error");
            notifyJobFinished("cancelled", currentJob.value?.kind || null);
            return;
        }
        if (currentStatus.value === "failed") {
            const message = currentJob.value?.error?.message || "Generation failed.";
            setMessage(message, "error");
            notifyJobFinished("failed", currentJob.value?.kind || null, message);
        }
    } catch (error) {
        if (version !== pollVersion) return;
        serviceOnline.value = false;
        setMessage(error instanceof Error ? error.message : String(error), "error");
        if (currentJob.value?.id === id && isJobRunning.value) {
            pollTimer = window.setTimeout(() => pollJob(id), normalizePollIntervalMs(pollIntervalMs.value));
        } else {
            stopElapsedTimer();
        }
    }
}

async function generate(): Promise<void> {
    if (!canGenerate.value || isJobRunning.value || mediaProcessing.value || submitting.value) return;
    const invalidSize = dimensionError({ width: form.width, height: form.height }, capabilities.value?.limits, dimensionMultiple.value);
    if (invalidSize) { setMessage(invalidSize, "error"); return; }
    if (generationMode.value === "video" && videoLength.error) { setMessage(videoLength.error, "error"); return; }
    submitting.value = true;
    try {
        await ensureNotificationPermission();
        const request = buildRequestBodyForMode(generationMode.value, {
            ...form,
            ...(generationMode.value === "video" ? { video_frames: videoLength.frames, fps: videoLength.fps } : {}),
            lora: loras.value.filter((item) => !loraInactiveReason(item)),
            preview_mode: previewMode.value,
            preview_interval: normalizePreviewInterval(previewInterval.value),
        }, generationFeatures.value);
        clearMessage();
        selectedOutputIndex.value = 0;
        startElapsedTimer();
        const job = generationMode.value === "video"
            ? await submitVideoJob(baseUrl.value, request)
            : await submitImageJob(baseUrl.value, request);
        const ratio = Number(request.width) / Number(request.height);
        submittedAspectRatio.value = Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
        currentJob.value = job;
        await pollJob(currentJob.value.id);
    } catch (error) {
        stopElapsedTimer();
        setMessage(error instanceof Error ? error.message : String(error), "error");
    } finally {
        submitting.value = false;
    }
}

async function cancelCurrentJob(): Promise<void> {
    if (!currentJob.value?.id || !canCancelCurrentJob.value) {
        return;
    }
    const id = currentJob.value.id;
    cancelling.value = true;
    stopPolling();
    ++pollVersion;
    try {
        currentJob.value = await cancelJob(baseUrl.value, id);
        await pollJob(id);
    } catch (error) {
        setMessage(error instanceof Error ? error.message : String(error), "error");
        pollTimer = window.setTimeout(() => pollJob(id), normalizePollIntervalMs(pollIntervalMs.value));
    } finally {
        cancelling.value = false;
    }
}

async function addLora(): Promise<void> {
    const index = loras.value.length;
    loras.value.push({
        path: "",
        multiplier: 1,
        is_high_noise: false,
    });
    await nextTick();
    document.getElementById(`lora-${index}`)?.focus();
}

function removeLora(index: number): void {
    loras.value.splice(index, 1);
}

async function assignImages(target: ImageTarget, files: FileList): Promise<void> {
    const images = await filesToImageEntries(files);
    if (!images.length) {
        return;
    }
    assignImageEntries(form, target, images);
}

function clearImage(target: ImageTarget): void {
    clearImageEntries(form, target);
}

function openImageEntry(image: ImageEntry | null): void {
    openLightbox(image?.dataUrl, image?.name);
}

function removeCollectionImage(target: "ref_images" | "control_frames", index: number): void {
    removeImageEntry(form, target, index);
}

async function replaceCollectionImage(target: "ref_images" | "control_frames", image: ImageEntry, files: FileList): Promise<void> {
    if (!files.length) return;
    const [replacement] = await filesToImageEntries([files[0]]);
    const index = form[target].indexOf(image);
    if (replacement && index >= 0) form[target].splice(index, 1, replacement);
}

function selectOutput(index: number): void {
    selectedOutputIndex.value = index;
}

function formatUnixTime(milliseconds: number | undefined): string {
    if (!milliseconds) {
        return "No job";
    }
    return new Date(milliseconds).toLocaleString();
}

function formatElapsed(job: Job | null): string {
    if (!job?.started) return "Idle";
    const elapsed = ((job.completed || nowMilliseconds.value) - job.started) / 1000;
    const total = Math.round(Math.max(0, elapsed) * 100) / 100;
    if (total < 60) return `${total.toFixed(2)}s`;
    const minutes = Math.floor(total / 60);
    return `${minutes}m ${(total - minutes * 60).toFixed(2)}s`;
}

function formatSummaryNumber(value: number, digits = 3): string {
    const numeric = Number(value ?? 0);
    if (!Number.isFinite(numeric)) {
        return "0";
    }
    return Number(numeric.toFixed(digits)).toString();
}

function downloadSelected(): void {
    if (!downloadableSrc.value) {
        return;
    }
    const link = document.createElement("a");
    link.href = downloadableSrc.value;
    link.download = `${currentJob.value?.id || "output"}.${currentJob.value?.result?.output_format || form.output_format}`;
    document.body.appendChild(link);
    link.click();
    link.remove();
}

function openLightbox(src: string | null | undefined = previewImageSrc.value, alt = "Expanded image"): void {
    if (!src) {
        return;
    }
    lightboxTrigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    composer.value?.close();
    lightboxImageSrc.value = src;
    lightboxImageAlt.value = alt;
    lightboxOpen.value = true;
    void nextTick(() => document.getElementById("lightbox-close")?.focus());
}

function closeLightbox(): void {
    lightboxOpen.value = false;
    lightboxImageSrc.value = "";
    lightboxImageAlt.value = "";
    if (lightboxTrigger?.getClientRects().length) lightboxTrigger.focus();
    else document.getElementById("generation-prompt")?.focus();
}

async function onPaste(event: ClipboardEvent): Promise<void> {
    if (!event.clipboardData?.files?.length || settingsOpen.value) return;
    await acceptReferenceFiles(event.clipboardData.files);
}

function onReferenceDragover(event: DragEvent): void {
    if (event.dataTransfer?.types.includes("Files") && (hasFeature("init_image") || hasFeature("ref_images"))) {
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
    }
}

async function onReferenceDrop(event: DragEvent): Promise<void> {
    if (event.defaultPrevented || !event.dataTransfer?.files.length) return;
    event.preventDefault();
    await acceptReferenceFiles(event.dataTransfer.files);
}

async function acceptReferenceFiles(files: FileList): Promise<void> {
    const target = hasFeature("init_image") ? "init_image" : hasFeature("ref_images") ? "ref_images" : null;
    if (!target) {
        setMessage("The selected model does not support initial or reference images.", "error");
        return;
    }
    try {
        await assignImages(target, files);
    } catch (error) {
        setMessage(error instanceof Error ? error.message : String(error), "error");
    }
}

watch(baseUrl, () => { selectedRecipe.value = null; });

watch(cacheModes, (modes) => { if (!modes.includes(form.cache.mode)) form.cache.mode = "disabled"; });
watch(generationFeatures, (features) => {
    if (generationMode.value === "video" && !features.ref_video_audios) videoInput.setUseAudio(false);
});

watch(generationMode, (mode) => {
    ensureOutputFormatForMode(mode);
});

watch(imageOutputFormats, () => {
    ensureOutputFormatForMode();
});

watch(videoOutputFormats, () => {
    ensureOutputFormatForMode();
});

onMounted(() => {
    refreshNotificationPermission();
    window.addEventListener("paste", onPaste);
    refreshCapabilities();
});

onBeforeUnmount(() => {
    stopPolling();
    stopElapsedTimer();
    window.removeEventListener("paste", onPaste);
});
</script>

<template>
    <div class="shell studio-shell" :class="{ 'studio-shell--creating': !settingsOpen }">
        <header class="studio-header">
            <a class="studio-brand" href="#" aria-label="stable-diffusion.cpp home" @click.prevent="settingsOpen = false"><img class="studio-brand__mark" :src="brandIcon" alt="" /><span>stable-diffusion.cpp</span></a>
            <div class="studio-header__actions">
                <StatusChip :status="serviceOnline ? 'online' : 'offline'" :label="serviceOnline ? 'Online' : 'Offline'" />
                <button class="btn-ghost studio-theme-toggle" type="button" :aria-label="themeToggleLabel" :title="themeToggleLabel" @click="toggleTheme">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
                        <template v-if="resolvedTheme === 'dark'">
                            <circle cx="12" cy="12" r="4" />
                            <path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42" />
                        </template>
                        <path v-else d="M20.9 13.3A9 9 0 0 1 10.7 3.1a9 9 0 1 0 10.2 10.2Z" />
                    </svg>
                </button>
                <button class="btn-ghost" type="button" :aria-pressed="settingsOpen" @click="openSettings">Settings</button>
            </div>
        </header>
        <section v-if="settingsOpen" class="studio-settings panel" aria-label="Settings">
            <div class="settings-heading"><h1>Settings</h1><button class="btn-secondary" type="button" @click="refreshCapabilities" :disabled="loadingCapabilities">{{ loadingCapabilities ? 'Refreshing…' : 'Refresh server info' }}</button></div>
            <div class="settings">
                <div class="settings__grid">
                    <div class="field">
                        <label for="theme">Theme</label>
                        <select id="theme" v-model="theme">
                            <option value="system">Device</option>
                            <option value="light">Light</option>
                            <option value="dark">Dark</option>
                        </select>
                    </div>
                    <div class="field">
                        <label>Base URL</label>
                        <input v-model="baseUrl" placeholder="Leave blank to use same origin" />
                    </div>
                    <div class="field">
                        <label>Queue Limit</label>
                        <input :value="queueLimit" readonly />
                    </div>
                    <div class="field">
                        <label>Output Formats ({{ generationMode === "video" ? "video" : "image" }})</label>
                        <input :value="outputFormats.join(', ')" readonly />
                    </div>
                    <div class="field">
                        <label>Output Format</label>
                        <select v-model="form.output_format">
                            <option v-for="format in outputFormats" :key="format" :value="format">{{ format }}</option>
                        </select>
                    </div>
                    <div class="field">
                        <label>Output Compression</label>
                        <input v-model.number="form.output_compression" type="number" min="0" max="100" />
                    </div>
                    <div class="field">
                        <label>Job Poll Interval (ms)</label>
                        <input v-model.number="pollIntervalMs" type="number" min="1" step="1" />
                    </div>
                </div>
                <PromptEnhancementSettings :enhancement="enhancement" />
                <fieldset class="settings__group">
                    <legend>Live Preview</legend>
                    <div class="settings__grid">
                        <div class="field">
                            <label for="preview-mode">Preview Mode</label>
                            <select id="preview-mode" v-model="preferredPreviewMode">
                                <option v-for="mode in previewModes" :key="mode" :value="mode">{{ mode }}</option>
                            </select>
                        </div>
                        <div class="field">
                            <label for="preview-interval">Interval (steps)</label>
                            <input id="preview-interval" v-model.number="previewInterval" type="number" min="1" step="1" :disabled="preferredPreviewMode === 'none'" />
                        </div>
                    </div>
                    <div v-if="(selectedRecipe || modelReady) && preferredPreviewMode !== previewMode" class="hint stack-top">
                        The selected preview mode is unavailable for the current model configuration. Preview will be disabled; your preference is saved.
                    </div>
                </fieldset>

                <fieldset class="settings__group stack-top">
                    <legend>Notifications</legend>
                    <label class="checkbox"><input v-model="notifyOnCompletion" type="checkbox" :disabled="!notificationSupported" @change="onNotifyToggle" /><span>Notify me when generation finishes</span></label>
                    <div class="hint stack-top">{{ notificationStatusMessage }}</div>
                </fieldset>

                <fieldset v-if="hasFeature('vae_tiling')" class="settings__group stack-top">
                    <legend>VAE Tiling</legend>
                    <label class="checkbox"><input v-model="form.vae_tiling_params.enabled" type="checkbox" /><span>Enabled</span></label>
                    <div class="settings__grid stack-top">
                        <div class="field">
                            <label for="vae-tile-width">Tile Width (px)</label>
                            <input id="vae-tile-width" v-model.number="form.vae_tiling_params.tile_size_w" type="number" :disabled="!form.vae_tiling_params.enabled" />
                        </div>
                        <div class="field">
                            <label for="vae-tile-height">Tile Height (px)</label>
                            <input id="vae-tile-height" v-model.number="form.vae_tiling_params.tile_size_h" type="number" :disabled="!form.vae_tiling_params.enabled" />
                        </div>
                        <div class="field">
                            <label for="vae-tile-overlap">Target Overlap</label>
                            <input id="vae-tile-overlap" v-model.number="form.vae_tiling_params.target_overlap" type="number" step="0.01" :disabled="!form.vae_tiling_params.enabled" />
                        </div>
                        <div class="field">
                            <label for="vae-tile-relative-width">Relative Width</label>
                            <input id="vae-tile-relative-width" v-model.number="form.vae_tiling_params.rel_size_w" type="number" step="0.01" :disabled="!form.vae_tiling_params.enabled" />
                        </div>
                        <div class="field">
                            <label for="vae-tile-relative-height">Relative Height</label>
                            <input id="vae-tile-relative-height" v-model.number="form.vae_tiling_params.rel_size_h" type="number" step="0.01" :disabled="!form.vae_tiling_params.enabled" />
                        </div>
                    </div>
                </fieldset>
                <div v-if="capabilitiesError" class="status-message status-message--error">{{ capabilitiesError }}</div>
            </div>
        </section>
        <main v-show="!settingsOpen" class="studio-workspace">
            <section class="output-stage" aria-label="Generated output" @dragover="onReferenceDragover" @drop="onReferenceDrop">
                <div class="output-canvas" :style="{ '--output-ratio': outputAspectRatio }">
                    <div v-if="livePreviewSrc" class="hero-frame hero-frame--media hero-frame--preview">
                        <img class="hero-frame__image" :src="livePreviewSrc" alt="Live preview" />
                        <div class="hero-frame__preview-overlay">
                            <span class="hero-frame__preview-label">Preview</span>
                        </div>
                    </div>
                    <div v-else-if="videoPreviewSrc" class="hero-frame hero-frame--media">
                        <video class="hero-frame__video" :src="videoPreviewSrc" controls autoplay loop muted playsinline />
                    </div>
                    <button v-else-if="previewImageSrc" class="hero-frame hero-frame--button" type="button" @click="openLightbox(previewImageSrc, 'Generated output')">
                        <img :src="previewImageSrc" alt="Generated output" />
                    </button>
                    <div v-else class="hero-frame hero-frame--empty">
                        <div v-if="!modelReady || previewingRecipe" class="hero-placeholder hero-placeholder--model">
                            <div aria-live="polite">
                                <h2>{{ modelStatus?.state === 'loading' ? 'Loading your model' : 'Choose a model to get started' }}</h2>
                                <p>{{ modelStatus?.state === 'loading'
                                    ? 'Your model is loading. You can prepare your prompt while you wait.'
                                    : 'Select a recipe and load its model, then bring your ideas to life.' }}</p>
                            </div>
                            <button class="btn model-start-action" type="button" aria-haspopup="dialog" aria-controls="composer-panel" @click="composer?.openModels($event)">{{ modelStatus?.state === 'loading' ? 'View loading status' : 'Choose & load model' }}</button>
                        </div>
                        <div v-else class="hero-placeholder">
                            <h2>{{ generationMode === "video" ? "Imagine it in motion" : "Make room for imagination" }}</h2>
                            <p>
                                {{ generationMode === "video"
                                    ? "Describe a scene below, add a reference, and create your next video."
                                    : "Start with a few words. Your next image will appear here." }}
                            </p>
                        </div>
                    </div>

                    <div class="canvas-overlays">
                        <div v-if="statusMessage && statusTone !== 'success'" class="status-message stage-message" role="status" :class="statusTone === 'error' ? 'status-message--error' : ''">{{ statusMessage }}</div>
                        <div v-else-if="currentJob?.error?.message" class="status-message status-message--error stage-message" role="alert">{{ currentJob.error.message }}</div>

                        <div v-if="currentImages.length > 1" class="thumb-row">
                            <button v-for="(image, index) in currentImages" :key="image.index" class="thumb" :class="{ 'thumb--active': index === selectedOutputIndex }" type="button" @click="selectOutput(index)">
                                <img :src="`data:image/${currentJob?.result?.output_format || 'png'};base64,${image.b64_json}`" :alt="`Output ${index + 1}`" />
                            </button>
                        </div>
                    </div>
                </div>

                <div class="stage-footer">
                    <GenerationProgress v-if="currentJob" :job="currentJob" :now="nowMilliseconds">
                        <template #actions>
                            <div class="stage-actions">
                                <button class="btn-ghost" type="button" aria-haspopup="dialog" @click="generationDetails?.showModal()">Details</button>
                                <button v-if="downloadableSrc" class="btn-secondary" type="button" @click="downloadSelected">Download</button>
                            </div>
                        </template>
                    </GenerationProgress>
                </div>
            </section>
            <PromptComposer ref="composer" :form="form" :mode="generationMode" :model-label="selectedRecipe?.name || (modelReady ? modelName : 'Choose model')"
                :enhancement="enhancement" @enhancement-settings="openEnhancementSettings"
                :model-ready="canGenerate" :disabled="!canGenerate || mediaProcessing || submitting || (generationMode === 'video' && Boolean(videoLength.error))" :busy="isJobRunning"
                :video-summary="videoLength.summary" :video-details="videoLength.details"
                :can-cancel="canCancelCurrentJob" :cancelling="cancelling || Boolean(currentJob?.cancel_requested)"
                :has-loras="showLoras" :lora-count="loras.filter(item => item.path).length"
                :limits="capabilities?.limits" :size-multiple="dimensionMultiple" :recommended="recommendedDimensions" @generate="generate" @cancel="cancelCurrentJob"
                @dragover="onReferenceDragover" @drop="onReferenceDrop">
                <template #inputs>
                    <ReferenceInputs :form="form" :mode="generationMode" :features="generationFeatures"
                        @select-image="assignImages" @clear-image="clearImage" @remove-image="removeCollectionImage" @replace-image="replaceCollectionImage" @preview="openImageEntry"
                        @select-media="(kind, files) => kind === 'video' ? videoInput.select(files) : audioInput.select(files)"
                        @clear-media="kind => kind === 'video' ? videoInput.clear() : audioInput.clear()" @preview-media="sectionState.referenceMedia = true; composer?.openMore($event)" />
                </template>
                <template #models>
        <ModelSelector embedded v-model:apply-defaults="applyRecipeDefaultsOnSelect" :base-url="baseUrl" :busy="isJobRunning" :lora-summary="loraSummary" @status="modelStatus = $event" @changed="refreshCapabilities" @recipe="selectRecipe" @selection="modelSelection = $event" @catalog-recipe="updateCatalogRecipe">
        </ModelSelector>
                </template>
                <template #lora>

                <section v-if="showLoras" class="model-loras" aria-labelledby="model-loras-title">
                    <div>
                        <h3 id="model-loras-title" class="model-loras__title">LoRAs <span>Optional</span></h3>
                        <div class="hint">Saved for this recipe. Applies on generation without reloading models.</div>
                    </div>
                    <div v-if="!loras.length" class="hint">{{ availableLoras.length ? 'No LoRAs selected.' : 'No LoRA files found. Add files and refresh.' }}</div>
                    <div v-for="(item, index) in loras" :key="index" class="lora-row" :class="{ 'lora-row--high-noise': showLoraHighNoise }">
                        <div class="field">
                            <label :for="'lora-' + index">LoRA {{ index + 1 }}</label>
                            <SearchableSelect :id="'lora-' + index" v-model="item.path" :aria-label="'LoRA ' + (index + 1)" :options="loraOptions" placeholder="Select a LoRA" contained />
                        </div>
                        <div class="field">
                            <label :for="'lora-multiplier-' + index">Strength</label>
                            <input :id="'lora-multiplier-' + index" v-model.number="item.multiplier" type="number" step="0.1" />
                        </div>
                        <div v-if="showLoraHighNoise" class="field">
                            <label :for="'lora-high-noise-' + index">High Noise</label>
                            <label class="checkbox lora-row__target">
                                <input :id="'lora-high-noise-' + index" v-model="item.is_high_noise" type="checkbox" />
                                <span>{{ item.is_high_noise ? "On" : "Off" }}</span>
                            </label>
                        </div>
                        <button class="btn-ghost lora-row__remove" type="button" :aria-label="'Remove LoRA ' + (index + 1)" @click="removeLora(index)">Remove</button>
                        <div v-if="loraInactiveReason(item)" class="hint lora-row__notice">{{ loraInactiveReason(item) }}</div>
                    </div>
                    <div class="actions">
                        <button class="btn-secondary" type="button" @click="addLora" :disabled="!hasFeature('lora') || !availableLoras.length">Add LoRA</button>
                    </div>
                </section>

                </template>
                <template #output>
                <div v-if="generationMode === 'image'" class="fields stack-top">
                    <div class="field"><label>Number of Images</label><input v-model.number="form.batch_count" type="number" min="1" /></div>
                    <div class="field">
                        <label for="image-seed">Seed</label>
                        <div class="seed-input">
                            <input id="image-seed" v-model.number="form.seed" type="number" />
                            <button class="btn-secondary" type="button" title="Generate a random seed" @click="randomizeSeed">Random</button>
                        </div>
                    </div>
                </div>
                <div v-else>
                    <div class="video-length-modes" role="group" aria-label="Video length input">
                        <button type="button" :aria-pressed="videoLength.mode === 'frames'" @click="videoLength.setMode('frames')">Frames</button>
                        <button type="button" :aria-pressed="videoLength.mode === 'duration'" @click="videoLength.setMode('duration')">Duration</button>
                    </div>
                    <div v-if="videoLength.mode === 'frames'" class="field stack-top">
                        <label for="video-frames">Frames</label>
                        <input id="video-frames" v-model.number="form.video_frames" type="number" min="1" max="4096" step="1" />
                    </div>
                    <div v-else class="field stack-top">
                        <label for="video-duration">Duration (seconds)</label>
                        <input id="video-duration" v-model.number="videoLength.duration" type="number" min="0" :max="4096 / videoLength.fps" step="any" />
                    </div>
                    <p v-if="videoLength.error" class="status-message status-message--error" role="alert">{{ videoLength.error }}</p>
                    <p v-else class="hint" aria-live="polite">{{ videoLength.frames }} frames · ≈{{ Number(videoLength.seconds.toFixed(3)) }} seconds after alignment</p>
                    <div class="fields stack-top">
                        <div class="field">
                            <label for="video-fps">FPS</label>
                            <input id="video-fps" v-model.number="videoLength.fps" type="number" min="1" max="240" step="1" :disabled="Boolean(videoConstraints?.fixed_fps)" />
                            <span v-if="videoConstraints?.fixed_fps" class="hint">Fixed by this recipe</span>
                        </div>
                        <div class="field">
                            <label for="video-seed">Seed</label>
                            <div class="seed-input">
                                <input id="video-seed" v-model.number="form.seed" type="number" />
                                <button class="btn-secondary" type="button" title="Generate a random seed" @click="randomizeSeed">Random</button>
                            </div>
                        </div>
                    </div>
                    <p class="hint">Estimated playback length. Audio-driven generation or temporal upscaling may change the final length.</p>
                </div>
                </template>
                <template #sample>
                    <p class="hint">{{ sampleSummary }}</p>
                    <div class="fields">
                        <div class="field">
                            <label>Scheduler</label>
                            <select v-model="form.sample_params.scheduler">
                                <option value="default">default</option>
                                <option v-for="scheduler in schedulers" :key="scheduler" :value="scheduler">{{ scheduler }}</option>
                            </select>
                        </div>
                        <div v-if="sampleHasFlowShift(form.sample_params)" class="field"><label>Flow Shift</label><input v-model="form.sample_params.flow_shift" type="number" step="0.01" placeholder="blank = default" /></div>
                        <div class="field">
                            <label>Method</label>
                            <select v-model="form.sample_params.sample_method">
                                <option value="default">default</option>
                                <option v-for="sampler in samplers" :key="sampler" :value="sampler">{{ sampler }}</option>
                            </select>
                        </div>
                        <div class="field"><label>Steps</label><input v-model.number="form.sample_params.sample_steps" type="number" /></div>
                    </div>
                    <div v-if="sampleHasExtras(form.sample_params)" class="sample-panel__extras">
                        <button class="module-card__link" type="button" @click="toggleSection('sampleAdvanced')">
                            {{ sectionState.sampleAdvanced ? "Hide extras" : "Show extras" }}
                        </button>
                    </div>
                    <div v-if="sectionState.sampleAdvanced && sampleHasExtras(form.sample_params)" class="fields">
                        <div v-if="sampleHasEta(form.sample_params)" class="field"><label>Eta</label><input v-model="form.sample_params.eta" type="number" step="0.01" placeholder="blank = default" /></div>
                        <div v-if="hasFeature('shifted_timestep')" class="field"><label>Shifted Timestep</label><input v-model.number="form.sample_params.shifted_timestep" type="number" /></div>
                    </div>
                <CollapsibleSection class="stack-top" eyebrow="Guidance" :summary="guidanceSummary" :open="sectionState.guidance" variant="module" @toggle="toggleSection('guidance')">
                    <div class="fields">
                        <div class="field"><label>CFG Scale</label><input v-model.number="form.sample_params.guidance.txt_cfg" type="number" step="0.1" /></div>
                        <div v-if="hasFeature('distilled_guidance')" class="field"><label>Distilled Guidance</label><input v-model.number="form.sample_params.guidance.distilled_guidance" type="number" step="0.1" /></div>
                    </div>
                    <div v-if="hasGuidanceExtras" class="sample-panel__extras">
                        <button class="module-card__link" type="button" @click="toggleSection('guidanceAdvanced')">
                            {{ sectionState.guidanceAdvanced ? "Hide extras" : "Show extras" }}
                        </button>
                    </div>
                    <div v-if="sectionState.guidanceAdvanced && hasGuidanceExtras" class="fields">
                        <div v-if="hasFeature('img_cfg')" class="field"><label>Image CFG</label><input v-model="form.sample_params.guidance.img_cfg" type="number" step="0.1" placeholder="blank = follow text cfg" /></div>
                        <div v-if="hasFeature('slg')" class="field"><label>SLG Layers</label><input v-model="form.sample_params.guidance.slg_layers" placeholder="7,8,9" /></div>
                        <div v-if="hasFeature('slg')" class="field"><label>SLG Layer Start</label><input v-model.number="form.sample_params.guidance.layer_start" type="number" step="0.01" /></div>
                        <div v-if="hasFeature('slg')" class="field"><label>SLG Layer End</label><input v-model.number="form.sample_params.guidance.layer_end" type="number" step="0.01" /></div>
                        <div v-if="hasFeature('slg')" class="field"><label>SLG Scale</label><input v-model.number="form.sample_params.guidance.scale" type="number" step="0.01" /></div>
                    </div>
                </CollapsibleSection>

                <CollapsibleSection v-if="hasFeature('high_noise')" class="stack-top" eyebrow="High Noise Pass" :summary="highNoiseSummary" :open="sectionState.highNoise" variant="module" @toggle="toggleSection('highNoise')">
                    <div class="field">
                        <label>MoE Boundary</label>
                        <input v-model.number="form.moe_boundary" type="number" step="0.001" />
                    </div>
                    <CollapsibleSection eyebrow="Sample" :summary="buildSampleSummary(form.high_noise_sample_params)" :open="sectionState.highNoiseSample" variant="plain" @toggle="toggleSection('highNoiseSample')">
                        <div class="fields">
                            <div class="field">
                                <label>Scheduler</label>
                                <select v-model="form.high_noise_sample_params.scheduler">
                                    <option value="default">default</option>
                                    <option v-for="scheduler in schedulers" :key="`high-noise-${scheduler}`" :value="scheduler">{{ scheduler }}</option>
                                </select>
                            </div>
                            <div v-if="sampleHasFlowShift(form.high_noise_sample_params)" class="field"><label>Flow Shift</label><input v-model="form.high_noise_sample_params.flow_shift" type="number" step="0.01" placeholder="blank = default" /></div>
                            <div class="field">
                                <label>Method</label>
                                <select v-model="form.high_noise_sample_params.sample_method">
                                    <option value="default">default</option>
                                    <option v-for="sampler in samplers" :key="`high-noise-${sampler}`" :value="sampler">{{ sampler }}</option>
                                </select>
                            </div>
                            <div class="field"><label>Steps</label><input v-model.number="form.high_noise_sample_params.sample_steps" type="number" /></div>
                            <div v-if="sampleHasEta(form.high_noise_sample_params)" class="field"><label>Eta</label><input v-model="form.high_noise_sample_params.eta" type="number" step="0.01" placeholder="blank = auto" /></div>
                            <div v-if="hasFeature('shifted_timestep')" class="field"><label>Shifted Timestep</label><input v-model.number="form.high_noise_sample_params.shifted_timestep" type="number" /></div>
                        </div>
                    </CollapsibleSection>
                    <CollapsibleSection class="stack-top" eyebrow="Guidance" :summary="buildGuidanceSummary(form.high_noise_sample_params)" :open="sectionState.highNoiseGuidance" variant="plain" @toggle="toggleSection('highNoiseGuidance')">
                        <div class="fields">
                            <div class="field"><label>CFG Scale</label><input v-model.number="form.high_noise_sample_params.guidance.txt_cfg" type="number" step="0.1" /></div>
                            <div v-if="hasFeature('distilled_guidance')" class="field"><label>Distilled Guidance</label><input v-model.number="form.high_noise_sample_params.guidance.distilled_guidance" type="number" step="0.1" /></div>
                            <div v-if="hasFeature('img_cfg')" class="field"><label>Image CFG</label><input v-model="form.high_noise_sample_params.guidance.img_cfg" type="number" step="0.1" placeholder="blank = follow text cfg" /></div>
                            <div v-if="hasFeature('slg')" class="field"><label>SLG Layers</label><input v-model="form.high_noise_sample_params.guidance.slg_layers" placeholder="7,8,9" /></div>
                            <div v-if="hasFeature('slg')" class="field"><label>SLG Layer Start</label><input v-model.number="form.high_noise_sample_params.guidance.layer_start" type="number" step="0.01" /></div>
                            <div v-if="hasFeature('slg')" class="field"><label>SLG Layer End</label><input v-model.number="form.high_noise_sample_params.guidance.layer_end" type="number" step="0.01" /></div>
                            <div v-if="hasFeature('slg')" class="field"><label>SLG Scale</label><input v-model.number="form.high_noise_sample_params.guidance.scale" type="number" step="0.01" /></div>
                        </div>
                    </CollapsibleSection>
                </CollapsibleSection>

                </template>
                <template #advanced>
                <CollapsibleSection v-if="(hasFeature('init_image') && hasFeature('img2img') && form.init_image) || hasFeature('ip_adapter_image')" class="stack-top" eyebrow="Image Settings" :summary="imageSettingsSummary" :open="sectionState.imageSettings" @toggle="toggleSection('imageSettings')">
                    <div class="fields">
                        <div v-if="hasFeature('init_image') && hasFeature('img2img') && form.init_image" class="field">
                            <label for="denoising-strength">Denoising Strength</label>
                            <input id="denoising-strength" v-model.number="form.strength" type="number" min="0" max="1" step="0.01" />
                            <div class="hint">Lower values preserve more of the initial image; higher values allow larger changes.</div>
                        </div>
                        <div v-if="hasFeature('ip_adapter_image')" class="field">
                            <label for="ip-adapter-strength">IP-Adapter Strength</label>
                            <input id="ip-adapter-strength" v-model.number="form.ip_adapter_strength" type="number" min="0" step="0.01" />
                        </div>
                    </div>
                </CollapsibleSection>

                <CollapsibleSection v-if="(hasFeature('ref_videos') && form.ref_video) || (hasFeature('ref_audios') && form.ref_audio)" class="stack-top" eyebrow="Reference Media" :summary="mediaSummary" :open="sectionState.referenceMedia" @toggle="toggleSection('referenceMedia')">
                    <MediaDropzone v-if="hasFeature('ref_videos') && form.ref_video" kind="video" :entry="form.ref_video" :allow-soundtrack="hasFeature('ref_video_audios')" @select="videoInput.select" @clear="videoInput.clear" @soundtrack="videoInput.setUseAudio" />
                    <MediaDropzone v-if="hasFeature('ref_audios') && form.ref_audio" kind="audio" :entry="form.ref_audio" @select="audioInput.select" @clear="audioInput.clear" />
                </CollapsibleSection>

                <CollapsibleSection v-if="hasConditioning" class="stack-top" eyebrow="Conditioning" :summary="conditioningSummary" :open="sectionState.conditioning" @toggle="toggleSection('conditioning')">
                    <div class="fields">
                        <div v-if="hasFeature('clip_skip')" class="field"><label>CLIP Skip</label><input v-model.number="form.clip_skip" type="number" /></div>
                        <div v-if="hasFeature('controlnet')" class="field"><label>Control Strength</label><input v-model.number="form.control_strength" type="number" step="0.01" /></div>
                        <div v-if="hasFeature('vace')" class="field"><label>VACE Strength</label><input v-model.number="form.vace_strength" type="number" step="0.01" /></div>
                    </div>
                </CollapsibleSection>

                <CollapsibleSection v-if="hasFeature('cache')" class="stack-top" eyebrow="Cache" :summary="cacheSummary" :open="sectionState.cache" @toggle="toggleSection('cache')">
                    <div class="field">
                        <label>Mode</label>
                        <select v-model="form.cache.mode">
                            <option v-for="mode in cacheModes" :key="mode" :value="mode">{{ mode }}</option>
                        </select>
                    </div>
                    <div v-if="form.cache.mode !== 'disabled'" class="field field--full"><label>Cache Option</label><input v-model="form.cache.option" placeholder="threshold=0.25,start=0.15,end=0.95" /></div>
                    <div v-if="usesSCM(form.cache.mode)" class="field"><label>SCM Mask</label><input v-model="form.cache.scm_mask" /></div>
                    <label v-if="usesSCM(form.cache.mode)" class="checkbox"><input v-model="form.cache.scm_policy_dynamic" type="checkbox" /><span>Dynamic SCM Policy</span></label>
                </CollapsibleSection>


                </template>
            </PromptComposer>
        </main>
        <dialog ref="generationDetails" class="generation-details" aria-labelledby="generation-details-title">
            <div class="generation-details__header">
                <h2 id="generation-details-title">Generation details</h2>
                <form method="dialog"><button class="btn-ghost" autofocus>Close</button></form>
            </div>
            <div v-if="currentJob" class="generation-details__body">
                <div class="metrics output-metrics">
                    <div class="metric">
                        <div class="metric__label">Status</div>
                        <div class="metric__value">{{ currentStatus }}</div>
                    </div>
                    <div class="metric">
                        <div class="metric__label">Queue</div>
                        <div class="metric__value">{{ currentJob?.queue_position ?? 0 }}</div>
                    </div>
                    <div class="metric">
                        <div class="metric__label">Created</div>
                        <div class="metric__value mono">{{ formatUnixTime(currentJob?.created) }}</div>
                    </div>
                    <div class="metric">
                        <div class="metric__label">Elapsed</div>
                        <div class="metric__value">{{ formatElapsed(currentJob) }}</div>
                    </div>
                    <div v-if="currentJobKind === 'vid_gen'" class="metric">
                        <div class="metric__label">FPS</div>
                        <div class="metric__value">{{ videoFps || "-" }}</div>
                    </div>
                    <div v-if="currentJobKind === 'vid_gen'" class="metric">
                        <div class="metric__label">Frames</div>
                        <div class="metric__value">{{ videoFrameCount || "-" }}</div>
                    </div>
                </div>
                <p v-if="currentJobKind === 'vid_gen' && currentJob.result?.output_format === 'avi'" class="hint">Browser playback for AVI depends on codec support. Download the file if the preview cannot play.</p>
                <p v-if="statusMessage" class="hint">{{ statusMessage }}</p>
            </div>
        </dialog>
        <div v-if="lightboxOpen && lightboxImageSrc" class="lightbox" role="dialog" aria-modal="true" aria-label="Expanded image" @click.self="closeLightbox" @keydown.esc.stop.prevent="closeLightbox" @keydown.tab.prevent>
            <button id="lightbox-close" class="lightbox__close" type="button" @click="closeLightbox">Close</button>
            <img class="lightbox__image" :src="lightboxImageSrc" :alt="lightboxImageAlt" />
        </div>
    </div>
</template>
