export interface PromptEnhancementRequest {
    baseUrl: string;
    apiKey: string;
    model: string;
    systemPrompt: string;
    prompt: string;
}

export function chatCompletionsUrl(baseUrl: string): string {
    let url: URL;
    try {
        url = new URL(baseUrl.trim());
    } catch {
        throw new Error("Enter a valid API base URL in Settings.");
    }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw new Error("Use an HTTP or HTTPS API URL without credentials, query parameters, or a fragment.");
    }
    url.pathname = url.pathname.replace(/\/+$/, "");
    if (!url.pathname.endsWith("/chat/completions")) url.pathname += "/chat/completions";
    return url.href;
}

function responseError(payload: any): string {
    const error = payload?.error;
    return typeof error?.message === "string" ? error.message : typeof error === "string" ? error : "";
}

function checkFinishReason(reason: unknown): void {
    if (reason === "length") throw new Error("The API stopped before finishing the prompt. Increase its output limit and try again.");
    if (reason === "content_filter") throw new Error("The API filtered the response. Try a different prompt.");
}

export async function enhancePrompt(request: PromptEnhancementRequest, signal: AbortSignal, onText: (text: string) => void): Promise<void> {
    const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "text/event-stream" };
    if (request.apiKey.trim()) headers.Authorization = `Bearer ${request.apiKey.trim()}`;
    const response = await fetch(chatCompletionsUrl(request.baseUrl), {
        method: "POST",
        headers,
        signal,
        credentials: "omit",
        body: JSON.stringify({
            model: request.model.trim(),
            messages: [
                { role: "system", content: request.systemPrompt },
                { role: "user", content: request.prompt },
            ],
            stream: true,
        }),
    });
    if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(responseError(payload) || `API request failed (HTTP ${response.status}).`);
    }

    // Some compatible servers return a complete JSON response even with stream enabled.
    if (response.headers.get("content-type")?.includes("application/json")) {
        const payload = await response.json();
        if (responseError(payload)) throw new Error(responseError(payload));
        const choice = payload?.choices?.[0];
        checkFinishReason(choice?.finish_reason);
        const content = choice?.message?.content;
        if (typeof content !== "string" || !content.trim()) throw new Error("The API returned no prompt text.");
        onText(content);
        return;
    }
    if (!response.headers.get("content-type")?.includes("text/event-stream") || !response.body) {
        throw new Error("The API did not return a chat completion stream. Check the API URL in Settings.");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let data: string[] = [];
    let text = "";
    let complete = false;
    let finished = false;

    function dispatch(): void {
        if (!data.length) return;
        const event = data.join("\n");
        data = [];
        if (event.trim() === "[DONE]") { complete = true; return; }
        let payload: any;
        try {
            payload = JSON.parse(event);
        } catch {
            throw new Error("The API returned an invalid streaming response.");
        }
        if (responseError(payload)) throw new Error(responseError(payload));
        const choices = Array.isArray(payload?.choices) ? payload.choices : [];
        const choice = choices.find((item: any) => item?.index === 0) ?? choices[0];
        checkFinishReason(choice?.finish_reason);
        if (choice?.finish_reason) finished = true;
        const content = choice?.delta?.content;
        if (typeof content === "string" && content) {
            text += content;
            onText(text);
        }
    }

    function consume(end: boolean): void {
        let index: number;
        while (!complete && (index = buffer.search(/[\r\n]/)) >= 0) {
            if (!end && buffer[index] === "\r" && index === buffer.length - 1) break;
            const line = buffer.slice(0, index);
            const length = buffer[index] === "\r" && buffer[index + 1] === "\n" ? 2 : 1;
            buffer = buffer.slice(index + length);
            if (!line) dispatch();
            else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
        }
        if (end && !complete) {
            if (buffer.startsWith("data:")) data.push(buffer.slice(5).replace(/^ /, ""));
            dispatch();
        }
    }

    try {
        while (!complete) {
            const { value, done } = await reader.read();
            buffer += decoder.decode(value, { stream: !done });
            consume(done);
            if (done) break;
        }
        if (!complete && !finished) throw new Error("The connection closed before the prompt was complete. Try again.");
        if (!text.trim()) throw new Error("The API returned no prompt text.");
    } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
    }
}
