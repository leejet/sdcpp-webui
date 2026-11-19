import { computed, onBeforeUnmount, reactive, ref, watch, type Ref } from "vue";
import { createStoredRef } from "./settings";
import { enhancePrompt } from "./prompt-enhancement-api";

interface PromptPreset {
    id: string;
    name: string;
    prompt: string;
}

const defaultPresets: PromptPreset[] = [{
    id: "default",
    name: "General",
    prompt: "Expand the user's image or video prompt into a detailed, coherent visual description. Preserve the subject, intent, and explicit constraints. Add useful composition, lighting, atmosphere, and visual details without unrelated elements. Return only the enhanced prompt, without explanations, headings, or quotation marks.",
}];

function normalizePresets(value: unknown): PromptPreset[] {
    if (Array.isArray(value) && value.every(item => item && typeof item.id === "string" && item.id &&
        typeof item.name === "string" && typeof item.prompt === "string") && new Set(value.map(item => item.id)).size === value.length) {
        return value;
    }
    return defaultPresets;
}

export function usePromptEnhancement(prompt: Ref<string>, mode: Ref<string>) {
    const storedString = (key: string, fallback = "") => createStoredRef(`sdcpp-webui-enhance-${key}`, fallback,
        (value: unknown) => typeof value === "string" ? value : fallback);
    const baseUrl = storedString("base-url");
    const apiKey = storedString("api-key");
    const model = storedString("model");
    const presets = createStoredRef<PromptPreset[]>("sdcpp-webui-enhance-presets", defaultPresets, normalizePresets);
    const activePresetId = storedString("preset", "default");
    const activePreset = computed(() => presets.value.find(item => item.id === activePresetId.value));
    const storedSystemPrompt = createStoredRef<string | null>("sdcpp-webui-enhance-system-prompt", null,
        (value: unknown) => typeof value === "string" ? value : null);
    if (storedSystemPrompt.value === null) storedSystemPrompt.value = activePreset.value?.prompt ?? defaultPresets[0].prompt;
    const systemPrompt = computed({ get: () => storedSystemPrompt.value ?? "", set: (value: string) => { storedSystemPrompt.value = value; } });
    if (!activePreset.value) activePresetId.value = "";
    const presetModified = computed(() => Boolean(activePreset.value && activePreset.value.prompt !== systemPrompt.value));
    const configured = computed(() => Boolean(baseUrl.value.trim() && model.value.trim() && systemPrompt.value.trim()));
    const enhancing = ref(false);
    const error = ref("");
    const original = ref<string | null>(null);
    const canRestore = computed(() => original.value !== null);
    let controller: AbortController | null = null;
    let applying = false;

    function selectPreset(id: string): void {
        const preset = presets.value.find(item => item.id === id);
        activePresetId.value = preset?.id ?? "";
        if (preset) systemPrompt.value = preset.prompt;
    }

    function savePreset(name: string): boolean {
        if (!name.trim() || !systemPrompt.value.trim()) return false;
        const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        presets.value = [...presets.value, { id, name: name.trim(), prompt: systemPrompt.value }];
        selectPreset(id);
        return true;
    }

    function updatePreset(): void {
        if (!activePreset.value || !systemPrompt.value.trim()) return;
        presets.value = presets.value.map(item => item.id === activePresetId.value
            ? { ...item, prompt: systemPrompt.value } : item);
    }

    function removePreset(): void {
        if (!activePreset.value) return;
        presets.value = presets.value.filter(item => item.id !== activePresetId.value);
        selectPreset("");
    }

    function setPrompt(value: string): void {
        applying = true;
        prompt.value = value;
        applying = false;
    }

    function cancel(): void {
        controller?.abort();
        controller = null;
        enhancing.value = false;
    }

    function restore(): void {
        cancel();
        if (original.value !== null) setPrompt(original.value);
        original.value = null;
        error.value = "";
    }

    async function enhance(): Promise<void> {
        if (enhancing.value || !(original.value ?? prompt.value).trim()) return;
        error.value = "";
        if (!configured.value) {
            error.value = "Configure the API URL, model, and system prompt in Settings first.";
            return;
        }
        const previous = prompt.value;
        const previousOriginal = original.value;
        const source = previousOriginal ?? previous;
        const current = new AbortController();
        controller = current;
        enhancing.value = true;
        let timedOut = false;
        const timeout = window.setTimeout(() => { timedOut = true; current.abort(); }, 120_000);
        try {
            await enhancePrompt({
                baseUrl: baseUrl.value, apiKey: apiKey.value, model: model.value,
                systemPrompt: systemPrompt.value, prompt: source,
            }, current.signal, text => {
                if (controller !== current || current.signal.aborted) return;
                original.value = source;
                setPrompt(text);
            });
        } catch (cause) {
            if (controller !== current) return;
            setPrompt(previous);
            original.value = previousOriginal;
            error.value = timedOut ? "The API request timed out. Try again." : cause instanceof TypeError
                ? "Cannot reach the API. Check its URL, connection, and browser CORS access."
                : cause instanceof Error ? cause.message : String(cause);
        } finally {
            window.clearTimeout(timeout);
            if (controller === current) {
                controller = null;
                enhancing.value = false;
            }
        }
    }

    watch([prompt, mode], () => {
        if (applying) return;
        cancel();
        original.value = null;
        error.value = "";
    }, { flush: "sync" });
    onBeforeUnmount(cancel);

    return reactive({
        baseUrl, apiKey, model, systemPrompt, presets, activePresetId, activePreset, presetModified, configured,
        enhancing, error, canRestore, selectPreset, savePreset, updatePreset, removePreset, enhance, cancel, restore,
    });
}

export type PromptEnhancement = ReturnType<typeof usePromptEnhancement>;
