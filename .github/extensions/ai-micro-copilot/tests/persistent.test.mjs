// SPDX-License-Identifier: MIT
import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { connectBridge } from "../bridge-rpc.mjs";

const id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const url = `ghapp://sessions/${id}`;
const snapshot = {
    sessions: [{ id, name: "Bound session", activity: { status: "idle" } }],
    catalogue: [{ id, app_url: url }],
};

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
