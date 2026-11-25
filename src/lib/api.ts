import type { Capabilities, Job, Recipe, ModelFile, ModelStatus, CatalogError, DglJob, ProgressJob } from "./types";

function withBase(baseUrl: string, path: string): string {
    const base = String(baseUrl || window.location.pathname).trim().replace(/\/+$/, "");
    return `${base}${path}`;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
    const response = await fetch(url, init);
    let payload: any = null;
    try {
        payload = await response.json();
    } catch {
        payload = null;
    }
    if (!response.ok) {
        throw new Error(
            (payload && (payload.error || payload.message)) || `HTTP ${response.status}`
        );
    }
    return payload as T;
}

export function getCapabilities(baseUrl: string): Promise<Capabilities> {
    return fetchJson<Capabilities>(withBase(baseUrl, "/sdcpp/v1/capabilities"));
}

export function submitImageJob(baseUrl: string, body: unknown): Promise<Job> {
    return fetchJson<Job>(withBase(baseUrl, "/sdcpp/v1/img_gen"), {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
    });
}

export function submitVideoJob(baseUrl: string, body: unknown): Promise<Job> {
    return fetchJson<Job>(withBase(baseUrl, "/sdcpp/v1/vid_gen"), {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
    });
}

export function getJob<T extends ProgressJob = Job>(baseUrl: string, id: string, signal?: AbortSignal): Promise<T> {
    return fetchJson<T>(withBase(baseUrl, `/sdcpp/v1/jobs/${encodeURIComponent(id)}`), { cache: "no-store", signal });
}

export function cancelJob(baseUrl: string, id: string): Promise<Job> {
    return fetchJson<Job>(withBase(baseUrl, `/sdcpp/v1/jobs/${id}/cancel`), {
        method: "POST",
    });
}

export function getRecipes(baseUrl: string): Promise<{ recipes: Recipe[]; errors: CatalogError[] }> {
    return fetchJson(withBase(baseUrl, "/sdcpp/v1/recipes"));
}
export function getModelFiles(baseUrl: string): Promise<{ files: ModelFile[]; errors: CatalogError[] }> {
    return fetchJson(withBase(baseUrl, "/sdcpp/v1/model-files"));
}
export function getModelStatus(baseUrl: string): Promise<ModelStatus> {
    return fetchJson(withBase(baseUrl, "/sdcpp/v1/models/status"));
}
export function refreshModels(baseUrl: string): Promise<{ errors: CatalogError[] }> {
    return fetchJson(withBase(baseUrl, "/sdcpp/v1/models/refresh"), { method: "POST" });
}

const dglPath = "/sdcpp/v1/dgl";

export function listDglScripts(): Promise<{ directory: string; scripts: string[] }> {
    return fetchJson(withBase("", dglPath + "/scripts"), { cache: "no-store" });
}

export function loadDglScript(name: string): Promise<{ source: string }> {
    return fetchJson(withBase("", dglPath + "/script?" + new URLSearchParams({ name })), { cache: "no-store" });
}

export function saveDglScript(name: string, source: string, previousSource?: string): Promise<{ name: string }> {
    return fetchJson(withBase("", dglPath + "/script"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, source, previous_source: previousSource }),
    });
}

export function submitDglJob(source: string, signal: AbortSignal): Promise<DglJob> {
    return fetchJson(withBase("", dglPath + "/jobs"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source }),
        signal,
    });
}
