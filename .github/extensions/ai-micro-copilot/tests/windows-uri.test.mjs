// SPDX-License-Identifier: MIT
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn, spawnSync } from "node:child_process";
import { createUriOpener } from "../windows-uri.mjs";
import { sessionUrl } from "../navigation.mjs";

test("URI opener rejects non-session links before starting a process", async () => {
    const opener = createUriOpener();
    try {
        for (const url of ["https://example.com", "ghapp://settings",
            "GHAPP://sessions/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee?command=x",
            "ghapp://sessions/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee\ncalc.exe"]) {
            await assert.rejects(opener.open(url), /Invalid Copilot session URL/);
        }
    } finally { opener.close(); }
});

test("Windows URI helper becomes ready, closes and can start again", {
    skip: process.platform !== "win32",
}, async () => {
    const errors = [];
    const opener = createUriOpener(error => errors.push(error));
    try {
        await Promise.all([opener.start(), opener.start()]);
        opener.close();
        await opener.start();
        assert.deepEqual(errors, []);
    } finally { opener.close(); }
});

test("Windows validator accepts App URL casing and rejects suffixes without opening the App", {
    skip: process.platform !== "win32",
}, async () => {
    const id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const errors = [];
    let command, safeArgs, options;
    const opener = createUriOpener(error => errors.push(error), (file, args, spawnOptions) => {
        const launch = "$process = [System.Diagnostics.Process]::Start($info)";
        const script = args.at(-1);
        assert.equal(script.split(launch).length, 2, "Replace exactly one OS launch before executing");
        // Run the production validator and protocol, stubbing only the OS launch.
        safeArgs = [...args.slice(0, -1), script.replace(launch, "$process = $null")];
        command = file;
        options = spawnOptions;
        return spawn(command, safeArgs, options);
    });
    try {
        for (const url of [
            `ghapp://sessions/${id}`,
            `GHAPP://sessions/${id}`,
            `GhApP://SeSsIoNs/${id}`,
        ]) {
            assert.equal(sessionUrl([{ id, app_url: url }], id), url);
            await opener.open(url);
        }
        // Feed invalid input directly to PowerShell so JS rejection cannot mask a helper regression.
        for (const suffix of ["?command=x", "#fragment", "/extra", ";calc.exe"]) {
            const result = spawnSync(command, safeArgs, {
                ...options, input: `GHAPP://sessions/${id}${suffix}\n`, encoding: "utf8", timeout: 10000,
            });
            assert.ifError(result.error);
            assert.equal(result.status, 0);
            assert.equal(result.stderr, "");
            assert.deepEqual(result.stdout.trim().split(/\r?\n/), [
                "READY", `ERROR:${Buffer.from("Invalid Copilot session URL").toString("base64")}`,
            ]);
        }
        assert.deepEqual(errors, []);
    } finally { opener.close(); }
});

test("Windows helper acknowledges serialized requests, fails without replay, and cancels queued opens on stop", {
    skip: process.platform !== "win32",
}, async t => {
    const children = [], writes = [], errors = [];
    const url = "ghapp://sessions/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const opener = createUriOpener(error => errors.push(error), () => {
        const child = new EventEmitter();
        child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
        child.kill = () => { child.killed = true; child.emit("exit", null, "SIGTERM"); };
        child.stdin.on("data", bytes => writes.push(bytes.toString()));
        children.push(child);
        queueMicrotask(() => child.stdout.write("READY\n"));
        return child;
    });
    const flush = () => new Promise(resolve => setImmediate(resolve));
    try {
        const first = opener.open(url), second = opener.open(url);
        await flush();
        assert.deepEqual(writes, [`${url}\n`]);
        children[0].stdout.write("OK\n");
        await first; await flush();
        assert.equal(children.length, 1);
        assert.equal(writes.length, 2);
        children[0].stdout.write("OK\n");
        await second;

        const failed = assert.rejects(opener.open(url), /exited/);
        await flush();
        children[0].emit("exit", 1, null);
        await failed;
        assert.equal(writes.length, 3);
        assert.equal(children.length, 1);

        const denied = assert.rejects(opener.open(url), /No URI handler/);
        await flush();
        children[1].stdout.write(`ERROR:${Buffer.from("No URI handler").toString("base64")}\n`);
        await denied;
        assert.equal(children[1].killed, true);

        await opener.start();
        t.mock.timers.enable({ apis: ["setTimeout"] });
        const timeout = assert.rejects(opener.open(url), /timed out/);
        await flush();
        t.mock.timers.tick(10000);
        await timeout;
        t.mock.timers.reset();
        assert.equal(children[2].killed, true);

        const cancelled = assert.rejects(opener.open(url), /stopped/);
        opener.close();
        await cancelled;
        assert.equal(children.length, 3);
        await opener.start();
        assert.equal(children.length, 4);
        opener.close();
        assert.deepEqual(errors, []);
    } finally { opener.close(); }
});
