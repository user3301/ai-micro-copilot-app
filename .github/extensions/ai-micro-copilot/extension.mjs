// SPDX-License-Identifier: MIT
import { joinSession } from "@github/copilot-sdk/extension";
import { readFile, writeFile, rename } from "node:fs/promises";
import { createServer } from "node:net";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { callApp, readSessions, validateConfig, DEFAULT_CONFIG, ACTIONS } from "./core.mjs";
import { Controller } from "./controller.mjs";
import { listDevices, MicroHid } from "./hid.mjs";
import { navigateSession } from "./navigation.mjs";

const configPath = fileURLToPath(new URL("./config.json", import.meta.url));
let config;
try { config = validateConfig(JSON.parse(await readFile(configPath, "utf8"))); }
catch (error) {
    if (error.code !== "ENOENT") throw error;
    config = structuredClone(DEFAULT_CONFIG);
}
let controller;
let lock;
async function releaseLock() {
    if (!lock) return;
    const server = lock; lock = null;
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
async function acquireLock() {
    if (process.platform !== "win32") throw new Error("This release supports Windows HID only");
    const owner = createHash("sha256").update(homedir()).digest("hex").slice(0, 16);
    const server = createServer(socket => socket.destroy());
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(`\\\\.\\pipe\\ai-micro-copilot-${owner}`, resolve);
    });
    server.on("error", error => controller.report(error));
    lock = server;
}
const properties = {
    operation: { type: "string", enum: ["sessions", "devices", "configure", "bind", "start", "stop", "status"] },
    slot: { type: "integer", minimum: 1, maximum: 6, description: "Agent key number for bind (1-based)." },
    sessionId: { type: ["string", "null"], description: "Session ID for bind; null clears only that key." },
    config: {
        type: "object", additionalProperties: false,
        properties: {
            slots: { type: "array", minItems: 6, maxItems: 6,
                items: { type: ["string", "null"] } },
            serialNumber: { type: ["string", "null"] },
            transport: { type: "string", enum: ["usb", "bluetooth"] },
            brightness: { type: "number", minimum: 0, maximum: 1 },
            pollMs: { type: "integer", minimum: 1000, maximum: 30000 },
            keys: { type: "object", additionalProperties: { type: "string", enum: ACTIONS } },
        },
    },
};
const session = await joinSession({
    tools: [
        {
            name: "ai_micro_control",
            description: "Manage the Windows USB/Bluetooth AI Micro bridge without flashing firmware. List sessions/devices; bind one Agent key (slot 1-6, sessionId or null) without changing other keys, or configure all six slots. Binding saves config.json and applies live. Select transport and device explicitly; stop before changing connection settings. Start only after user selects bindings. Does not approve prompts or send agent messages.",
            parameters: { type: "object", properties, required: ["operation"], additionalProperties: false },
            handler: async ({ operation, config: update, slot, sessionId }) => {
                try {
                    let result;
                    if (operation === "sessions") result = await readSessions(session);
                    else if (operation === "devices") result = (await listDevices())
                        .map(d => ({ transport: d.transport, serialNumber: d.serialNumber, product: d.product, path: d.path }));
                    else if (operation === "bind") result = await controller.bind(slot, sessionId);
                    else if (operation === "configure") {
                        if (!update) throw new Error("configure requires config");
                        result = await controller.configure(update);
                    } else if (operation === "start") {
                        if (!controller.running) {
                            await acquireLock();
                            try { await controller.start(); }
                            catch (error) { await releaseLock(); throw error; }
                        }
                        result = controller.status();
                    } else if (operation === "stop") {
                        try { await controller.stop(); }
                        finally { await releaseLock(); }
                        result = controller.status();
                    } else if (operation === "status") result = controller.status();
                    else throw new Error("Unknown operation");
                    return { resultType: "success", textResultForLlm: JSON.stringify(result) };
                } catch (error) {
                    return { resultType: "failure", textResultForLlm: error.message };
                }
            },
        },
    ],
});
controller = new Controller({
    config, readSessions: () => readSessions(session),
    call: (name, args) => callApp(session, name, args),
    navigate: id => navigateSession(session, id),
    open: options => MicroHid.open(options),
    save: async value => {
        await writeFile(`${configPath}.tmp`, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
        await rename(`${configPath}.tmp`, configPath);
    },
    log: (message, level) => {
        session.log(`[AI Micro] ${message}`, { level }).catch(error =>
            console.error(`[AI Micro] ${message}; timeline logging failed: ${error.message}`));
    },
});
let stopping = false;
async function shutdown() {
    if (stopping) return;
    stopping = true;
    try { await controller.stop(); }
    catch (error) { console.error(`[AI Micro] Shutdown: ${error.message}`); }
    finally {
        try { await releaseLock(); }
        catch (error) { console.error(`[AI Micro] Lock cleanup: ${error.message}`); }
    }
}
session.on("session.shutdown", () => { void shutdown(); });
for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => { shutdown().finally(() => process.exit(0)); });
}
