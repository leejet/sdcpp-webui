import type { Capabilities, GenerationMode } from "./types";

export interface Dimensions { width: number; height: number }
export interface InputResolution { size: Dimensions; label: "Init image" | "Reference image" }
export interface ResolutionPreset { id: string; label: string; value: number }

export const ASPECT_RATIOS = [
    { label: "1:1", value: 1 },
    { label: "16:9", value: 16 / 9 },
    { label: "9:16", value: 9 / 16 },
    { label: "4:3", value: 4 / 3 },
    { label: "3:4", value: 3 / 4 },
    { label: "3:2", value: 3 / 2 },
    { label: "2:3", value: 2 / 3 },
];

export function resolutionPresets(mode: GenerationMode): ResolutionPreset[] {
    return mode === "video"
        ? [480, 720, 1080].map((value) => ({ id: String(value), label: `${value}p`, value }))
        : [
            { id: "512", label: "0.25 MP · 512", value: 512 ** 2 },
            { id: "1024", label: "1 MP · ~1K", value: 1024 ** 2 },
            { id: "1536", label: "2.25 MP · ~1.5K", value: 1536 ** 2 },
            { id: "2048", label: "4 MP · ~2K", value: 2048 ** 2 },
        ];
}

export function sizeMultiple(value?: number): number {
    return value !== undefined && Number.isInteger(value) && value >= 1 && value <= 4096 ? value : 8;
}

export function alignDimension(value: number, multiple = 8): number {
    const step = sizeMultiple(multiple);
    return Math.ceil(value / step) * step;
}

export function alignDimensions(size: Dimensions, multiple = 8): Dimensions {
    return { width: alignDimension(size.width, multiple), height: alignDimension(size.height, multiple) };
}

export function fitInputDimensions(size: Dimensions, limits?: Capabilities["limits"], multiple = 8): Dimensions {
    const step = sizeMultiple(multiple);
    const min = alignDimensions({ width: limits?.min_width ?? 64, height: limits?.min_height ?? 64 }, step);
    const max = {
        width: Math.floor((limits?.max_width ?? 4096) / step) * step,
        height: Math.floor((limits?.max_height ?? 4096) / step) * step,
    };
    const minScale = Math.max(min.width / size.width, min.height / size.height);
    const maxScale = Math.min(max.width / size.width, max.height / size.height);
    const scale = Math.min(maxScale, Math.max(1, minScale));
    const aligned = alignDimensions({ width: size.width * scale, height: size.height * scale }, step);
    return {
        width: Math.min(max.width, Math.max(min.width, aligned.width)),
        height: Math.min(max.height, Math.max(min.height, aligned.height)),
    };
}

export function dimensionsForResolution(ratio: number, value: number, mode: GenerationMode, multiple = 8): Dimensions {
    const safeRatio = Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
    const height = mode === "image" ? Math.sqrt(value / safeRatio) : value / Math.min(safeRatio, 1);
    return alignDimensions({ width: height * safeRatio, height }, multiple);
}

export function dimensionError(size: Dimensions, limits?: Capabilities["limits"], multiple = 8): string {
    for (const axis of ["width", "height"] as const) {
        const value = size[axis];
        const min = limits?.[`min_${axis}`] ?? 64;
        const max = limits?.[`max_${axis}`] ?? 4096;
        if (!Number.isInteger(value) || value < min || value > max) {
            return `${axis === "width" ? "Width" : "Height"} must be a whole number from ${min} to ${max} px.`;
        }
        const step = sizeMultiple(multiple);
        if (value % step !== 0) {
            return `${axis === "width" ? "Width" : "Height"} must be a multiple of ${step} px.`;
        }
    }
    return "";
}

export function aspectLabel({ width, height }: Dimensions, multiple = 8): string {
    if (!(width > 0 && height > 0)) return "Custom";
    const ratio = width / height;
    const step = sizeMultiple(multiple);
    const closest = [...ASPECT_RATIOS].sort((a, b) => Math.abs(ratio / a.value - 1) - Math.abs(ratio / b.value - 1))[0];
    const offset = width - height * closest.value;
    const match = offset > -closest.value * step && offset < step ? closest : undefined;
    if (match) return `${Math.abs(ratio - match.value) < 0.00001 ? "" : "~"}${match.label}`;
    return "Custom";
}
