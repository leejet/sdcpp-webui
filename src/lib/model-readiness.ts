import type { ModelStatus, Recipe } from "./types";

function normalizedSelection(selection: Record<string, string>): string {
    return JSON.stringify(Object.entries(selection).filter(([, value]) => value).sort(([a], [b]) => a.localeCompare(b)));
}

export function selectedModelIsReady(status: ModelStatus | null, recipe: Recipe | null, selection: Record<string, string>): boolean {
    if (!status || status.state !== "ready" || !recipe) return false;
    if (recipe.source === "command_line") return status.origin === "command_line";
    return status.recipe === recipe.id && normalizedSelection(status.models) === normalizedSelection(selection);
}

export function canLoadAndGenerate(status: ModelStatus | null, recipe: Recipe | null, loadable: boolean): boolean {
    return Boolean(status && status.state !== "loading" && recipe && loadable);
}
