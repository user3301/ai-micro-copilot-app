// SPDX-License-Identifier: MIT
import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { mkdtemp, writeFile, unlink, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BridgeClient } from "../bridge-client.mjs";

test("A newly loaded extension automatically resumes status without restarting HID or undoing explicit stop", {
    skip: process.platform !== "win32", timeout: 20000,
}, async () => {
    const endpoint = `\\\\.\\pipe\\ai-micro-copilot-${randomBytes(8).toString("hex")}`;
    const token = randomBytes(32).toString("hex");
    const directory = await mkdtemp(join(tmpdir(), "ai-micro-client-"));
    const runtimePath = join(directory, ".bridge-runtime.json"), configPath = join(directory, "config.json");
    const child = fork(new URL("./fixtures/persistent-worker.mjs", import.meta.url), [endpoint, token], {
        stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    child.stderr.on("data", chunk => process.stderr.write(chunk));
    const id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const logs = [], clients = [];
    let unavailable = false;
    const session = { rpc: { tools: { execute: async ({ name }) => {
        if (unavailable) throw new Error("App unavailable");
        assert(["get_sessions_status", "list_sessions_and_chats"].includes(name));
        return { resultType: "success", structuredContent: name === "get_sessions_status"
            ? { sessions: [{ id, activity: { status: "idle" } }] } : [{ id, app_url: `ghapp://sessions/${id}` }] };
    } } } };
    const makeClient = () => {
        const client = new BridgeClient({ session, runtimePath, configPath,
            log: message => logs.push(message) });
        clients.push(client);
        return client;
    };
    try {
        await once(child, "message");
        await writeFile(runtimePath, JSON.stringify({ protocol: 1, endpoint, token, configPath }));
        const first = makeClient();
        assert.equal((await first.request("start")).running, true);
        first.close();
        const second = makeClient();
        second.start();
        await second.queue;
        const recovered = await second.request("status");
        assert.equal(recovered.running, true);
        assert.equal(recovered.appConnected, true);
        assert.equal(recovered.stale, false);
        unavailable = true;
        await assert.rejects(second.request("configure", { brightness: 0.5 }), /App unavailable/);
        assert.equal((await second.request("status")).stale, true);
        await second.request("stop");
        second.close();
        unavailable = false;
        const third = makeClient();
        third.start();
        await third.queue;
        assert.equal((await third.request("status")).running, false);
        assert.deepEqual(logs, []);
    } finally {
        for (const client of clients) client.close();
        child.kill(); await once(child, "exit");
        await unlink(runtimePath);
        await rmdir(directory);
    }
});
