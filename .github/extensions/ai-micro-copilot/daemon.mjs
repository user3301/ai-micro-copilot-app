// SPDX-License-Identifier: MIT
import { readFile, writeFile, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { validateConfig, DEFAULT_CONFIG } from "./core.mjs";
import { MicroHid } from "./hid.mjs";
import { createUriOpener } from "./windows-uri.mjs";
import { BridgeService } from "./bridge-service.mjs";
import { connectBridge } from "./bridge-rpc.mjs";

if (process.platform !== "win32") throw new Error("The standalone bridge requires Windows");
const configPath = fileURLToPath(new URL("./config.json", import.meta.url));
const runtimePath = fileURLToPath(new URL("./.bridge-runtime.json", import.meta.url));
if (process.argv[2] === "--stop") {
    const peer = await connectBridge(JSON.parse(await readFile(runtimePath, "utf8")));
    try { console.log(JSON.stringify(await peer.request("stop"))); }
    finally { peer.close(); }
} else {
    if (process.argv.length > 2) throw new Error("Usage: node daemon.mjs [--stop]");
    let config;
    try { config = validateConfig(JSON.parse(await readFile(configPath, "utf8"))); }
    catch (error) {
        if (error.code !== "ENOENT") throw error;
        config = structuredClone(DEFAULT_CONFIG);
    }
    const token = randomBytes(32).toString("hex");
    const owner = createHash("sha256").update(homedir()).digest("hex").slice(0, 16);
    // Shares the original extension's singleton lock; an old bridge must stop before migration.
    const endpoint = `\\\\.\\pipe\\ai-micro-copilot-${owner}`;
    const log = (message, level = "info") =>
        console.error(`${new Date().toISOString()} [AI Micro ${level}] ${message}`);
    const opener = createUriOpener(error => service.controller.report(error));
    const service = new BridgeService({
        config, token, open: options => MicroHid.open(options),
        navigate: url => opener.open(url), prepare: () => opener.start(), release: () => opener.close(),
        save: async value => {
            await writeFile(`${configPath}.tmp`, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
            await rename(`${configPath}.tmp`, configPath);
        },
        log,
    });
    await service.listen(endpoint);
    try {
        await writeFile(`${runtimePath}.tmp`, JSON.stringify({
            protocol: 1, endpoint, token, pid: process.pid, configPath,
        }) + "\n", { mode: 0o600 });
        await rename(`${runtimePath}.tmp`, runtimePath);
    } catch (error) { await service.close(); throw error; }
    let stopping = false;
    const shutdown = async () => {
        if (stopping) return;
        stopping = true;
        try { await service.close(); }
        finally { await unlink(runtimePath); }
    };
    for (const signal of ["SIGINT", "SIGTERM"]) {
        process.once(signal, () => {
            shutdown().then(() => process.exit(0), error => {
                log(`Shutdown failed: ${error.message}`, "error"); process.exit(1);
            });
        });
    }
    log(`Independent bridge ready (PID ${process.pid}); waiting for explicit start`);
}
