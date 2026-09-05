const BASE_URL = "http://127.0.0.1:8080";

function showResult(data: unknown): void {
    const result = document.getElementById("result") as HTMLPreElement;
    result.textContent = JSON.stringify(data, null, 2);
}

async function request<T>(url: string, method: string = "GET", body?: unknown): Promise<T> {
    const options: RequestInit = {
        method,
        headers: {
            "Content-Type": "application/json"
        }
    };
    if (body !== undefined) {
        options.body = JSON.stringify(body);
    }
    const res = await fetch(BASE_URL + url, options);
    if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    return await res.json() as T;
}

async function getSkills(): Promise<void> {
    try {
        showResult(await request("/skills"));
    } catch (e) {
        showResult({ error: (e as Error).message });
    }
}

async function getReload(): Promise<void> {
    try {
        showResult(await request("/reload"));
    } catch (e) {
        showResult({ error: (e as Error).message });
    }
}

async function getClear(): Promise<void> {
    try {
        showResult(await request("/clear"));
    } catch (e) {
        showResult({ error: (e as Error).message });
    }
}

async function postTalk(): Promise<void> {
    const input = document.getElementById("talk-input") as HTMLTextAreaElement;
    const text = input.value.trim();
    if (!text) {
        showResult({ error: "Please enter some text for /talk" });
        return;
    }
    try {
        showResult(await request("/talk", "POST", { text }));
    } catch (e) {
        showResult({ error: (e as Error).message });
    }
}

async function postCd(): Promise<void> {
    const input = document.getElementById("cd-input") as HTMLInputElement;
    const path = input.value.trim();
    if (!path) {
        showResult({ error: "Please enter a path for /cd" });
        return;
    }
    try {
        showResult(await request("/cd", "POST", { path }));
    } catch (e) {
        showResult({ error: (e as Error).message });
    }
}

function setup(): void {
    document.getElementById("btn-skills")?.addEventListener("click", () => { getSkills(); });
    document.getElementById("btn-reload")?.addEventListener("click", () => { getReload(); });
    document.getElementById("btn-clear")?.addEventListener("click", () => { getClear(); });
    document.getElementById("btn-talk")?.addEventListener("click", () => { postTalk(); });
    document.getElementById("btn-cd")?.addEventListener("click", () => { postCd(); });
}

window.addEventListener("DOMContentLoaded", setup);