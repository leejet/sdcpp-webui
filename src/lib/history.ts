import type { buildImageRequestBody, buildRequestBodyForMode } from "./form-request";
import type { GenerationForm, ImageEntry, ImageOutput, Job } from "./types";

type ImageRequest = ReturnType<typeof buildImageRequestBody>;
type SubmittedParameters = Omit<ImageRequest, "init_image" | "mask_image" | "control_image" | "ref_images">;

interface InputSummary {
    label: string;
    files: Array<Pick<ImageEntry, "name" | "type">>;
}

export interface ImageSubmission {
    model: string;
    serverUrl: string;
    parameters: SubmittedParameters;
    inputs: InputSummary[];
}

export interface PendingImageSubmission {
    jobId: string;
    submission: ImageSubmission;
}

export interface ImageHistoryEntry extends ImageSubmission {
    key: string;
    jobId: string;
    created?: number;
    completed?: number;
    outputFormat: string;
    images: ImageOutput[];
}

export function createImageSubmission(
    request: ReturnType<typeof buildRequestBodyForMode>,
    form: GenerationForm,
    model: string,
    serverUrl: string,
): ImageSubmission | null {
    if (!("ref_images" in request)) {
        return null;
    }

    // Keep the submitted values, without retaining a second copy of input images.
    const { init_image, mask_image, control_image, ref_images, ...parameters } = request;
    const inputs: InputSummary[] = [];
    const sources: Array<[string, Array<ImageEntry | null>]> = [
        ["Init Image", [form.init_image]],
        ["Mask Image", [form.mask_image]],
        ["Control Image", [form.control_image]],
        ["Reference Images", form.ref_images],
    ];
    for (const [label, entries] of sources) {
        const files = entries
            .filter((entry): entry is ImageEntry => entry !== null)
            .map(({ name, type }) => ({ name, type }));
        if (files.length) {
            inputs.push({ label, files });
        }
    }

    return {
        model,
        serverUrl,
        parameters: JSON.parse(JSON.stringify(parameters)),
        inputs,
    };
}

export function recordImageHistory(
    entries: ImageHistoryEntry[],
    job: Job,
    pending: PendingImageSubmission | null,
): ImageHistoryEntry[] {
    if (!pending || pending.jobId !== job.id || job.kind !== "img_gen"
        || job.status !== "completed" || !job.result?.images?.length) {
        return entries;
    }
    const key = JSON.stringify([pending.submission.serverUrl, job.id]);
    if (entries.some((entry) => entry.key === key)) {
        return entries;
    }

    return [{
        ...pending.submission,
        key,
        jobId: job.id,
        created: job.created,
        completed: job.completed,
        outputFormat: job.result.output_format || pending.submission.parameters.output_format,
        images: job.result.images.map((image) => ({ ...image })),
    }, ...entries];
}
