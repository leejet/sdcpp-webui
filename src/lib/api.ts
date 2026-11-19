import type { Capabilities, Job, Recipe, ModelFile, ModelStatus, CatalogError } from "./types";

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

export function getJob(baseUrl: string, id: string): Promise<Job> {
    return fetchJson<Job>(withBase(baseUrl, `/sdcpp/v1/jobs/${id}`), { cache: "no-store" });
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
export function loadModel(baseUrl: string, recipe: string, models: Record<string, string>): Promise<ModelStatus> {
    return fetchJson(withBase(baseUrl, "/sdcpp/v1/models/load"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recipe, models }),
    });
}
export function unloadModel(baseUrl: string): Promise<ModelStatus> {
    return fetchJson(withBase(baseUrl, "/sdcpp/v1/models/unload"), { method: "POST" });
}

export function setModelTTL(baseUrl: string, seconds: number): Promise<ModelStatus> {
    return fetchJson(withBase(baseUrl, "/sdcpp/v1/models/settings"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sleep_idle_seconds: seconds }),
    });
}
