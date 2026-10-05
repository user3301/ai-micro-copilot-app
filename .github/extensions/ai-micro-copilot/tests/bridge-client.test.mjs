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

test("Large App catalogues support startup, polling and new bindings without exceeding RPC limits", {
    skip: process.platform !== "win32", timeout: 20000,
}, async () => {
    const endpoint = `\\\\.\\pipe\\ai-micro-copilot-${randomBytes(8).toString("hex")}`;
    const token = randomBytes(32).toString("hex");
    const directory = await mkdtemp(join(tmpdir(), "ai-micro-large-client-"));
    const runtimePath = join(directory, ".bridge-runtime.json"), configPath = join(directory, "config.json");
    const child = fork(new URL("./fixtures/persistent-worker.mjs", import.meta.url), [endpoint, token], {
        stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    child.stderr.on("data", chunk => process.stderr.write(chunk));
    const original = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const ids = [original, ...Array.from({ length: 12000 }, (_, i) =>
        `${i.toString(16).padStart(8, "0")}-bbbb-cccc-dddd-eeeeeeeeeeee`)];
    const sessions = ids.map(id => ({ id, name: `Session ${id}`, activity: { status: "idle" } }));
    let catalogue = ids.map(id => ({ id, app_url: `ghapp://sessions/${id}` }));
    assert(Buffer.byteLength(JSON.stringify(catalogue)) > 1024 * 1024);
    assert(Buffer.byteLength(JSON.stringify(sessions)) > 1024 * 1024);
    const session = { rpc: { tools: { execute: async ({ name }) => {
        assert(["get_sessions_status", "list_sessions_and_chats"].includes(name));
        return { resultType: "success", structuredContent: name === "get_sessions_status"
            ? { sessions } : catalogue };
    } } } };
    const logs = [];
    const client = new BridgeClient({ session, runtimePath, configPath, log: message => logs.push(message) });
    const inspectInput = async () => {
        const reply = once(child, "message");
        child.send({ input: true });
        return (await reply)[0];
    };
    try {
        await once(child, "message");
        await writeFile(runtimePath, JSON.stringify({ protocol: 1, endpoint, token, configPath }));
        assert.equal((await client.request("start")).appConnected, true);
        assert.deepEqual((await inspectInput()).opened, [`ghapp://sessions/${original}`]);
        const replacement = ids.at(-1), added = ids.at(-2);
        const rebound = await client.request("bind", { slot: 1, sessionId: replacement });
        assert.equal(rebound.slots[0].sessionId, replacement);
        const configured = await client.request("configure", {
            slots: [replacement, added, null, null, null, null],
        });
        assert.equal(configured.slots[1].sessionId, added);
        client.start();
        await client.queue;
        assert.equal((await client.request("status")).stale, false);
        assert.deepEqual((await inspectInput()).opened, [
            `ghapp://sessions/${original}`, `ghapp://sessions/${replacement}`,
        ]);
        assert.equal((await client.request("bind", { slot: 2, sessionId: null })).slots[1].sessionId, null);
        const invalid = ids.at(-3);
        catalogue = catalogue.map(item => item.id === invalid ? { ...item, app_url: "https://example.com" } : item);
        await assert.rejects(client.request("bind", { slot: 2, sessionId: invalid }), /invalid session URL/);
        assert.equal((await client.request("status")).slots[1].sessionId, null);
        await client.request("configure", { brightness: 0.5 });
        assert.equal((await client.request("status")).appConnected, true);
        assert.deepEqual(logs, []);
        await client.request("stop");
    } finally {
        client.close();
        child.kill(); await once(child, "exit");
        await unlink(runtimePath);
        await rmdir(directory);
    }
});

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
