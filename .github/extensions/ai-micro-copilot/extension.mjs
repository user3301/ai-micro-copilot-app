// SPDX-License-Identifier: MIT
import { joinSession } from "@github/copilot-sdk/extension";
import { fileURLToPath } from "node:url";
import { readSessions, ACTIONS } from "./core.mjs";
import { listDevices } from "./hid.mjs";
import { BridgeClient } from "./bridge-client.mjs";

const configPath = fileURLToPath(new URL("./config.json", import.meta.url));
let client;
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
            backgroundIdleMs: { type: "integer", minimum: 0, maximum: 86400000,
                description: "Hardware inactivity before background and function-key lights turn off; default 300000 ms (5 minutes). Agent LEDs stay on. 0 disables." },
            keys: { type: "object", additionalProperties: { type: "string", enum: ACTIONS } },
        },
    },
};
const session = await joinSession({
    tools: [
        {
            name: "ai_micro_control",
            description: "Manage the independent Windows AI Micro USB/Bluetooth bridge. The daemon must be launched separately with node daemon.mjs. Session-host shutdown disconnects the status feed, not the keyboard: verified cached navigation remains available and LEDs become unknown. Bind one key (slot 1-6), configure, start, stop or inspect status. Preserve other bindings; stop before changing transport/device. Start only with user-selected bindings. No firmware flashing, permission approval or agent messages.",
            parameters: { type: "object", properties, required: ["operation"], additionalProperties: false },
            handler: async ({ operation, config: update, slot, sessionId }) => {
                try {
                    let result;
                    if (operation === "sessions") result = await readSessions(session);
                    else if (operation === "devices") result = (await listDevices())
                        .map(d => ({ transport: d.transport, serialNumber: d.serialNumber, product: d.product, path: d.path }));
                    else if (operation === "bind") {
                        result = await client.request("bind", { slot, sessionId });
                    }
                    else if (operation === "configure") {
                        if (!update) throw new Error("configure requires config");
                        result = await client.request("configure", update);
                    } else if (["start", "stop", "status"].includes(operation))
                        result = await client.request(operation);
                    else throw new Error("Unknown operation");
                    return { resultType: "success", textResultForLlm: JSON.stringify(result) };
                } catch (error) {
                    return { resultType: "failure", textResultForLlm: error.message };
                }
            },
        },
    ],
});
client = new BridgeClient({
    session, configPath,
    runtimePath: fileURLToPath(new URL("./.bridge-runtime.json", import.meta.url)),
    log: (message, level) => {
        session.log(`[AI Micro] ${message}`, { level }).catch(error =>
            console.error(`[AI Micro] ${message}; timeline logging failed: ${error.message}`));
    },
});
client.start();
session.on("session.shutdown", () => client.close());
for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => { client.close(); process.exit(0); });
}
