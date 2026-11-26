import type { GenerationForm, ImageEntry, ImageTarget } from "./types";

export function readFileAsDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error(`failed to read ${file.name}`));
        reader.readAsDataURL(file);
    });
}

function jpegDimensions(bytes: ArrayBuffer): ImageEntry["dimensions"] {
    const data = new DataView(bytes);
    let offset = 2;
    while (offset + 3 < data.byteLength && data.getUint8(offset++) === 0xff) {
        while (offset < data.byteLength && data.getUint8(offset) === 0xff) offset++;
        if (offset + 2 >= data.byteLength) return;
        const marker = data.getUint8(offset++);
        if (marker === 0xda || marker === 0xd9) return;
        const length = data.getUint16(offset);
        if (length < 2 || offset + length > data.byteLength) return;
        if (length >= 8 && (marker === 0xc0 || marker === 0xc1 || marker === 0xc2)) {
            const width = data.getUint16(offset + 5);
            const height = data.getUint16(offset + 3);
            return width && height ? { width, height } : undefined;
        }
        offset += length;
    }
}

async function imageDimensions(file: File, dataUrl: string): Promise<ImageEntry["dimensions"]> {
    if (dataUrl.startsWith("/9j/", dataUrl.indexOf(",") + 1)) {
        // JPEG frame dimensions match the server's decoder before any EXIF rotation.
        const dimensions = await file.arrayBuffer().then(jpegDimensions, () => undefined);
        if (dimensions) return dimensions;
    }
    return new Promise((resolve) => {
        const image = new Image();
        image.onload = () => {
            const { naturalWidth: width, naturalHeight: height } = image;
            resolve(width && height ? { width, height } : undefined);
        };
        image.onerror = () => resolve(undefined);
        image.src = dataUrl;
    });
}

export async function filesToImageEntries(fileList: FileList | File[], readDimensions = false): Promise<ImageEntry[]> {
    const files = Array.from(fileList || []);
    return Promise.all(files.map(async (file) => {
        const dataUrl = await readFileAsDataUrl(file);
        return {
            name: file.name,
            type: file.type || "image/png",
            dataUrl,
            dimensions: readDimensions ? await imageDimensions(file, dataUrl) : undefined,
        };
    }));
}

export function assignImageEntries(form: GenerationForm, target: ImageTarget, images: ImageEntry[]): void {
    if (target === "init_image" || target === "mask_image" || target === "control_image" || target === "ip_adapter_image" || target === "end_image") {
        form[target] = images[0] || null;
        return;
    }
    if (target === "ref_images" || target === "control_frames") {
        form[target].push(...images);
    }
}

export function clearImageEntries(form: GenerationForm, target: ImageTarget): void {
    if (target === "init_image" || target === "mask_image" || target === "control_image" || target === "ip_adapter_image" || target === "end_image") {
        form[target] = null;
        return;
    }
    if (target === "ref_images" || target === "control_frames") {
        form[target].splice(0);
    }
}

export function removeImageEntry(form: GenerationForm, target: ImageTarget, index: number): void {
    if (target === "ref_images" || target === "control_frames") {
        form[target].splice(index, 1);
    }
}
