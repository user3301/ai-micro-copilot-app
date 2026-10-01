// SPDX-License-Identifier: MIT
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { callApp } from "./core.mjs";

const execFileAsync = promisify(execFile);

export function sessionUrl(result, id) {
    let items = result;
    if (typeof result === "string") {
        const text = result.replace(/^Found \d+ item\(s\):\s*/, "");
        items = JSON.parse(text);
    }
    if (!Array.isArray(items)) throw new Error("Unsupported App session catalogue format");
    const matches = items.filter(item => item?.id === id);
    if (matches.length !== 1) throw new Error("Session URL is missing or ambiguous");
    const url = matches[0].app_url;
    const match = typeof url === "string" &&
        /^ghapp:\/\/sessions\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(url);
    if (!match || match[1] !== id) throw new Error("App returned an invalid session URL");
    return url;
}

export async function openSessionUrl(url) {
    if (process.platform !== "win32" || !process.env.SystemRoot)
        throw new Error("Opening Copilot sessions requires Windows");
    // URI is data, not interpolated PowerShell code. ShellExecute uses the registered App handler.
    await execFileAsync(join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), [
        "-NoProfile", "-NonInteractive", "-Command",
        "$ErrorActionPreference = 'Stop'; Start-Process -FilePath $env:AI_MICRO_SESSION_URL",
    ], { windowsHide: true, timeout: 10000, env: { ...process.env, AI_MICRO_SESSION_URL: url } });
}

export async function navigateSession(session, id, open = openSessionUrl) {
    const items = await callApp(session, "list_sessions_and_chats");
    await open(sessionUrl(items, id));
}

export function createNavigator(session, open = openSessionUrl, now = () => performance.now()) {
    let items = null, expires = 0;
    const clear = () => { items = null; expires = 0; };
    const refresh = async () => {
        if (items !== null && now() < expires) return;
        clear();
        const result = await callApp(session, "list_sessions_and_chats");
        const parsed = typeof result === "string"
            ? JSON.parse(result.replace(/^Found \d+ item\(s\):\s*/, "")) : result;
        if (!Array.isArray(parsed)) throw new Error("Unsupported App session catalogue format");
        items = parsed;
        expires = now() + 30000;
    };
    return {
        clear, refresh,
        async navigate(id) {
            try {
                await refresh();
                if (!items.some(item => item?.id === id)) {
                    clear();
                    await refresh();
                }
                await open(sessionUrl(items, id));
            } catch (error) {
                clear();
                throw error;
            }
        },
    };
}
