import type { Capabilities, Job, Recipe, ModelFile, ModelStatus, CatalogError, DglJob, ProgressJob } from "./types";

function withBase(baseUrl: string, path: string): string {
    const base = String(baseUrl || window.location.pathname).trim().replace(/\/+$/, "");
    return `${base}${path}`;
}

const sessionKeys = new Map<string, string>();

function serverKeyScope(baseUrl: string): string {
    const base = new URL(withBase(baseUrl, "/"), window.location.href);
    if ((base.protocol !== "http:" && base.protocol !== "https:") || base.username || base.password || base.search || base.hash) {
        throw new Error("Enter an HTTP or HTTPS server URL.");
    }
    return "sdcpp-webui-server-key:" + base.href;
}

export function readServerApiKey(baseUrl: string): string {
    try {
        const scope = serverKeyScope(baseUrl);
        return sessionKeys.get(scope) ?? window.sessionStorage.getItem(scope) ?? "";
    } catch {
        return "";
    }
}

export function saveServerApiKey(baseUrl: string, input: string): void {
    const scope = serverKeyScope(baseUrl);
    const key = input.trim();
    if (key) new Headers({ Authorization: "Bearer " + key });
    sessionKeys.set(scope, key);
    try {
        if (key) window.sessionStorage.setItem(scope, key);
        else window.sessionStorage.removeItem(scope);
    } catch {
        // In-memory settings also work when browser storage is unavailable.
    }
}

function fetchServer(baseUrl: string, url: string, init?: RequestInit): Promise<Response> {
    const key = readServerApiKey(baseUrl);
    if (!key) return fetch(url, init);
    const headers = new Headers(init?.headers);
    headers.set("Authorization", "Bearer " + key);
    return fetch(url, { ...init, headers, redirect: "error" });
}

export function fetchServerMedia(url: string, init?: RequestInit): Promise<Response> {
    const target = new URL(url, window.location.href);
    if (target.origin !== window.location.origin) throw new Error("Media view requires a same-origin URL.");
    return fetchServer("", target.href, init);
}

async function fetchJson<T>(baseUrl: string, path: string, init?: RequestInit): Promise<T> {
    const response = await fetchServer(baseUrl, withBase(baseUrl, path), init);
    let payload: any = null;
    try {
        payload = await response.json();
    } catch {
        payload = null;
    }
    if (!response.ok) {
        throw new Error(
            (typeof payload?.error === "string" ? payload.error : payload?.error?.message) ||
            payload?.message || `HTTP ${response.status}`
        );
    }
    return payload as T;
}

export function getCapabilities(baseUrl: string): Promise<Capabilities> {
    return fetchJson<Capabilities>(baseUrl, "/sdcpp/v1/capabilities");
}

export function mediaViewUrl(root: string, path: string, revision = 0): string {
    const params = new URLSearchParams({ root, path });
    if (revision) params.set("v", String(revision));
    return withBase("", "/sdcpp/v1/view?" + params);
}

export function submitImageJob(baseUrl: string, body: unknown): Promise<Job> {
    return fetchJson<Job>(baseUrl, "/sdcpp/v1/img_gen", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
    });
}

export function submitVideoJob(baseUrl: string, body: unknown): Promise<Job> {
    return fetchJson<Job>(baseUrl, "/sdcpp/v1/vid_gen", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
    });
}

export function getJob<T extends ProgressJob = Job>(baseUrl: string, id: string, signal?: AbortSignal): Promise<T> {
    return fetchJson<T>(baseUrl, `/sdcpp/v1/jobs/${encodeURIComponent(id)}`, { cache: "no-store", signal });
}

export function cancelJob(baseUrl: string, id: string): Promise<Job> {
    return fetchJson<Job>(baseUrl, `/sdcpp/v1/jobs/${id}/cancel`, {
        method: "POST",
    });
}

export function getRecipes(baseUrl: string): Promise<{ recipes: Recipe[]; errors: CatalogError[] }> {
    return fetchJson(baseUrl, "/sdcpp/v1/recipes");
}
export function getModelFiles(baseUrl: string): Promise<{ files: ModelFile[]; errors: CatalogError[] }> {
    return fetchJson(baseUrl, "/sdcpp/v1/model-files");
}
export function getModelStatus(baseUrl: string): Promise<ModelStatus> {
    return fetchJson(baseUrl, "/sdcpp/v1/models/status");
}
export function refreshModels(baseUrl: string): Promise<{ errors: CatalogError[] }> {
    return fetchJson(baseUrl, "/sdcpp/v1/models/refresh", { method: "POST" });
}

const dglPath = "/sdcpp/v1/dgl";

export function listDglScripts(): Promise<{ directory: string; scripts: string[] }> {
    return fetchJson("", dglPath + "/scripts", { cache: "no-store" });
}

export function loadDglScript(name: string): Promise<{ source: string }> {
    return fetchJson("", dglPath + "/script?" + new URLSearchParams({ name }), { cache: "no-store" });
}

export function saveDglScript(name: string, source: string, previousSource?: string): Promise<{ name: string }> {
    return fetchJson("", dglPath + "/script", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, source, previous_source: previousSource }),
    });
}

export function submitDglJob(source: string, signal: AbortSignal): Promise<DglJob> {
    return fetchJson("", dglPath + "/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source }),
        signal,
    });
}
