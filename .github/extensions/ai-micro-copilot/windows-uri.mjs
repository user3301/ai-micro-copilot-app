// SPDX-License-Identifier: MIT
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { join } from "node:path";

const sessionLink = /^ghapp:\/\/sessions\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const script = `
$ErrorActionPreference = 'Stop'
$info = New-Object System.Diagnostics.ProcessStartInfo
$info.UseShellExecute = $true
[Console]::Out.WriteLine('READY')
while ($null -ne ($url = [Console]::In.ReadLine())) {
    try {
        if ($url -cnotmatch '^ghapp://sessions/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$') {
            throw 'Invalid Copilot session URL'
        }
        $info.FileName = $url
        $process = [System.Diagnostics.Process]::Start($info)
        if ($null -ne $process) { $process.Dispose() }
        [Console]::Out.WriteLine('OK')
    } catch {
        [Console]::Out.WriteLine('ERROR:' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($_.Exception.Message)))
    }
}
`;

export function createUriOpener(report = error => console.error(`[AI Micro] ${error.message}`), spawnWorker = spawn) {
    let worker = null, queue = Promise.resolve(), generation = 0;
    function retire(current, error) {
        if (worker !== current) return;
        worker = null;
        current.lines.close();
        current.child.kill();
        if (current.pending) {
            clearTimeout(current.pending.timer);
            current.pending.reject(error);
            current.pending = null;
        } else if (error) report(error);
    }
    function wait(current, expected) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() =>
                retire(current, new Error("Windows URI helper timed out; navigation was not retried")), 10000);
            current.pending = { resolve, reject, timer, expected };
        });
    }
    function start() {
        if (worker) return worker.ready;
        if (process.platform !== "win32" || !process.env.SystemRoot)
            return Promise.reject(new Error("Opening Copilot sessions requires Windows"));
        const child = spawnWorker(join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
            ["-NoProfile", "-NonInteractive", "-Command", script],
            { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
        const current = { child, lines: createInterface({ input: child.stdout }), pending: null };
        worker = current;
        current.ready = wait(current, "READY");
        current.lines.on("line", line => {
            if (worker !== current) return;
            const pending = current.pending;
            if (!pending) return retire(current, new Error("Unexpected Windows URI helper response"));
            if (line !== pending.expected) {
                const detail = line.startsWith("ERROR:")
                    ? Buffer.from(line.slice(6), "base64").toString("utf8") : "invalid response";
                return retire(current, new Error(`Windows URI helper: ${detail}`));
            }
            clearTimeout(pending.timer);
            current.pending = null;
            pending.resolve();
        });
        child.once("error", error => retire(current, error));
        child.stdin.on("error", error => retire(current, error));
        child.stderr.on("data", () => retire(current, new Error("Windows URI helper wrote an error")));
        child.once("exit", (code, signal) =>
            retire(current, new Error(`Windows URI helper exited (${signal ?? code})`)));
        return current.ready;
    }
    return {
        start,
        open(url) {
            if (typeof url !== "string" || !sessionLink.test(url) || /[\r\n]/.test(url))
                return Promise.reject(new Error("Invalid Copilot session URL"));
            const requestedGeneration = generation;
            const run = queue.then(async () => {
                if (generation !== requestedGeneration) throw new Error("Windows URI helper stopped");
                await start();
                if (generation !== requestedGeneration) throw new Error("Windows URI helper stopped");
                const current = worker;
                if (!current) throw new Error("Windows URI helper stopped");
                const reply = wait(current, "OK");
                current.child.stdin.write(`${url}\n`);
                await reply;
            });
            queue = run.catch(() => {});
            return run;
        },
        close() {
            generation++;
            if (worker) retire(worker, worker.pending ? new Error("Windows URI helper stopped") : null);
        },
    };
}
