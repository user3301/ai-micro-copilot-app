// SPDX-License-Identifier: MIT
import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { mkdtemp, readFile, writeFile, unlink, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectBridge } from "../bridge-rpc.mjs";
import { BridgeService } from "../bridge-service.mjs";

const id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const url = `ghapp://sessions/${id}`;
const snapshot = {
    sessions: [{ id, name: "Bound session", activity: { status: "idle" } }],
    catalogue: [{ id, app_url: url }],
};

test("Shutdown retains the singleton until HID and discovery cleanup finish", {
    skip: process.platform !== "win32", timeout: 20000,
}, async () => {
    const endpoint = `\\\\.\\pipe\\ai-micro-test-${randomUUID()}`, token = randomUUID();
    const directory = await mkdtemp(join(tmpdir(), "ai-micro-shutdown-"));
    const runtimePath = join(directory, ".bridge-runtime.json");
    let enteringClose, finishClose, enteringCleanup, finishCleanup;
    const closing = new Promise(resolve => { enteringClose = resolve; });
    const closeGate = new Promise(resolve => { finishClose = resolve; });
    const cleaning = new Promise(resolve => { enteringCleanup = resolve; });
    const cleanupGate = new Promise(resolve => { finishCleanup = resolve; });
    const device = new EventEmitter();
    device.request = async () => {};
    device.close = async () => { enteringClose(); await closeGate; };
    const service = new BridgeService({
        config: { slots: [id, null, null, null, null, null] }, token,
        open: async () => device, navigate: async () => {}, save: async () => {}, log: () => {},
    });
    const contenders = [];
    const claim = async () => {
        const server = createServer(socket => socket.destroy());
        contenders.push(server);
        await new Promise((resolve, reject) => {
            server.once("error", reject);
            server.listen(endpoint, resolve);
        });
    };
    let peer, shutdown;
    try {
        await service.listen(endpoint);
        await writeFile(runtimePath, "old runtime");
        peer = await connectBridge({ endpoint, token });
        await peer.request("attach");
        await peer.request("snapshot", snapshot);
        await peer.request("start");
        shutdown = service.close(async () => {
            enteringCleanup();
            await cleanupGate;
            await unlink(runtimePath);
        });
        await closing;
        await assert.rejects(claim(), { code: "EADDRINUSE" });
        await assert.rejects(connectBridge({ endpoint, token }));
        assert.equal(await readFile(runtimePath, "utf8"), "old runtime");
        finishClose();
        await cleaning;
        await assert.rejects(claim(), { code: "EADDRINUSE" });
        finishCleanup();
        await shutdown;
        await assert.rejects(readFile(runtimePath), { code: "ENOENT" });
        await claim();
        await writeFile(runtimePath, "replacement runtime");
        await service.close();
        assert.equal(await readFile(runtimePath, "utf8"), "replacement runtime");
    } finally {
        finishClose(); finishCleanup();
        peer?.close();
        await shutdown;
        await service.close();
        for (const server of contenders) {
            if (server.listening) await new Promise(resolve => server.close(resolve));
        }
        await unlink(runtimePath).catch(error => { if (error.code !== "ENOENT") throw error; });
        await rmdir(directory);
    }
});

test("Service shutdown rejects new starts while HID close is pending", {
    skip: process.platform !== "win32", timeout: 20000,
}, async () => {
    const endpoint = `\\\\.\\pipe\\ai-micro-test-${randomUUID()}`, token = randomUUID();
    let closingDevice, finishDeviceClose, opens = 0, prepares = 0;
    const deviceClosing = new Promise(resolve => { closingDevice = resolve; });
    const deviceCloseGate = new Promise(resolve => { finishDeviceClose = resolve; });
    const device = new EventEmitter();
    device.request = async () => {};
    device.close = async () => { closingDevice(); await deviceCloseGate; };
    const service = new BridgeService({
        config: { slots: [id, null, null, null, null, null] }, token,
        open: async () => { opens++; return device; },
        prepare: async () => { prepares++; },
        navigate: async () => {}, save: async () => {}, log: () => {},
    });
    let peer, shutdown;
    try {
        await service.listen(endpoint);
        peer = await connectBridge({ endpoint, token });
        await peer.request("attach");
        await peer.request("snapshot", snapshot);
        await peer.request("start");
        shutdown = service.close();
        await deviceClosing;
        const lateStart = peer.request("start").then(
            () => "accepted", error => error.message);
        // The status request is a wire-order barrier for the preceding start.
        await peer.request("status").catch(() => {});
        finishDeviceClose();
        await shutdown;
        assert.match(await lateStart, /closed|shutting down|EPIPE|ECONNRESET/i);
        assert.equal(prepares, 1, "Shutdown must not launch another URI helper");
        assert.equal(opens, 1, "Shutdown must not reopen HID");
        assert.equal(service.status().running, false);
        assert.equal(service.status().connected, false);
        await assert.rejects(connectBridge({ endpoint, token }));
    } finally {
        finishDeviceClose();
        peer?.close();
        await shutdown;
        await service.close();
    }
});

test("Service shutdown drains an in-flight start and concurrent closes share final cleanup", {
    skip: process.platform !== "win32", timeout: 20000,
}, async () => {
    const endpoint = `\\\\.\\pipe\\ai-micro-test-${randomUUID()}`, token = randomUUID();
    let enteringOpen, finishOpen, deviceCloses = 0, releases = 0;
    const opening = new Promise(resolve => { enteringOpen = resolve; });
    const openGate = new Promise(resolve => { finishOpen = resolve; });
    const device = new EventEmitter();
    device.request = async () => {};
    device.close = async () => { deviceCloses++; };
    const service = new BridgeService({
        config: { slots: [id, null, null, null, null, null] }, token,
        open: async () => { enteringOpen(); await openGate; return device; },
        release: () => { releases++; },
        navigate: async () => {}, save: async () => {}, log: () => {},
    });
    let peer, shutdown, start;
    try {
        await service.listen(endpoint);
        peer = await connectBridge({ endpoint, token });
        await peer.request("attach");
        await peer.request("snapshot", snapshot);
        start = peer.request("start").then(() => "accepted", error => error.message);
        await opening;
        shutdown = service.close();
        assert.equal(service.close(), shutdown);
        let complete = false;
        shutdown.then(() => { complete = true; });
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(complete, false, "Cleanup must wait for an already running start");
        assert.equal(releases, 0);
        finishOpen();
        await shutdown;
        await start;
        assert.equal(deviceCloses, 1);
        assert.equal(releases, 1);
        assert.equal(service.status().running, false);
        assert.equal(service.status().connected, false);
    } finally {
        finishOpen();
        peer?.close();
        await start;
        await shutdown;
        await service.close();
    }
});

test("Separate HID process survives feed loss, navigates offline, restores state and honors explicit stop", {
    skip: process.platform !== "win32", timeout: 20000,
}, async () => {
    const endpoint = `\\\\.\\pipe\\ai-micro-test-${randomUUID()}`;
    const token = randomUUID();
    const child = fork(new URL("./fixtures/persistent-worker.mjs", import.meta.url), [endpoint, token], {
        stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    let diagnostics = "";
    child.stderr.on("data", chunk => { diagnostics += chunk; });
    let peer, producer;
    const inspectInput = async () => {
        const reply = once(child, "message");
        child.send({ input: true });
        return (await reply)[0];
    };
    try {
        const [ready] = await once(child, "message");
        assert.equal(ready.ready, true, diagnostics);
        producer = fork(new URL("./fixtures/feed-worker.mjs", import.meta.url), [endpoint, token], {
            stdio: ["ignore", "ignore", "pipe", "ipc"],
        });
        producer.stderr.on("data", chunk => { diagnostics += chunk; });
        const [started] = await once(producer, "message");
        assert.equal(started.connected, true);
        assert.equal(started.stale, false);
        const exited = once(producer, "exit");
        producer.kill();
        await exited;
        peer = await connectBridge({ endpoint, token });
        const offline = await inspectInput();
        assert.deepEqual(offline.opened, [url]);
        assert.equal(offline.status.running, true);
        assert.equal(offline.status.stale, true);
        assert.equal(offline.status.slots[0].state, "unknown");
        assert.equal(offline.lights[0].c, 0x8050ff);
        assert.equal(offline.closed, false);
        await assert.rejects(peer.request("configure", { brightness: 0.5 }), /App status unavailable/);

        await peer.request("attach");
        await peer.request("snapshot", snapshot);
        const recovered = await inspectInput();
        assert.equal(recovered.status.stale, false);
        assert.equal(recovered.lights[0].c, 0x00cc66);
        assert.deepEqual(recovered.opened, [url, url]);
        await peer.request("stop");
        await peer.request("snapshot", snapshot);
        const stopped = await inspectInput();
        assert.equal(stopped.status.running, false);
        assert.equal(stopped.closed, true);
        assert.equal(stopped.opened.length, 2);
    } finally {
        peer?.close();
        child.kill();
        await once(child, "exit");
    }
});

test("Feed expiry and invalid updates cannot leave live LEDs or bypass URL validation", {
    skip: process.platform !== "win32", timeout: 20000,
}, async () => {
    const endpoint = `\\\\.\\pipe\\ai-micro-test-${randomUUID()}`, token = randomUUID();
    const child = fork(new URL("./fixtures/persistent-worker.mjs", import.meta.url), [endpoint, token], {
        stdio: ["ignore", "ignore", "pipe", "ipc"],
    });

    child.stderr.on("data", chunk => process.stderr.write(chunk));
    let peer, second;
    const inspect = async message => {
        const reply = once(child, "message"); child.send(message); return (await reply)[0];
    };
    try {
        await once(child, "message");
        await assert.rejects(connectBridge({ endpoint, token: "wrong" }), /authentication/);
        peer = await connectBridge({ endpoint, token });
        await peer.request("attach");
        await peer.request("snapshot", snapshot);
        await peer.request("start");
        second = await connectBridge({ endpoint, token });
        await assert.rejects(second.request("attach"), /Another extension/);
        await assert.rejects(second.request("snapshot", snapshot), /Attach/);
        const expired = await inspect({ advance: 5000, input: true });
        assert.equal(expired.status.appConnected, false);
        assert.equal(expired.status.stale, true);
        assert.deepEqual(expired.opened, [url]);
        assert.equal(expired.lights[0].c, 0x8050ff);
        await peer.request("snapshot", snapshot);
        await assert.rejects(peer.request("snapshot", {
            ...snapshot, catalogue: [{ id, app_url: `${url}?bad=1` }],
        }), /invalid session URL/);
        const invalid = await inspect({ input: true });
        assert.equal(invalid.opened.length, 1);
        assert.equal(invalid.status.stale, true);
        await peer.request("snapshot", snapshot);
        await peer.request("snapshot", { sessions: [], catalogue: [] });
        const removed = await inspect({ input: true });
        assert.equal(removed.opened.length, 1);
        assert.match(removed.status.error, /unavailable/);
        await peer.request("stop");
    } finally {
        peer?.close(); second?.close();
        child.kill(); await once(child, "exit");
    }
});
