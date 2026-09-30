// SPDX-License-Identifier: MIT
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { writeFile, unlink, open as openFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Decoder, encodeReports, validateConfig, DEFAULT_CONFIG, eventAction,
    lightsFor, sessionState, nextSlot, parseSnapshot, callApp, readSessions } from "../core.mjs";
import { MicroHid, isUsbMicro, supportedFirmware, deviceTransport, selectDevice } from "../hid.mjs";
import { Controller } from "../controller.mjs";
import { sessionUrl, navigateSession } from "../navigation.mjs";

test("Report 6 framing round trips UTF-8, escapes, adjacent objects and maximum length", () => {
    const decoder = new Decoder();
    for (const message of [{ text: '\u4e2d\u6587\\"{}[]'.repeat(60) }, { x: "a".repeat(4088) }]) {
        const reports = encodeReports(message);
        assert(reports.length > 1);
        assert(reports.every(r => r.length === 64 && r[0] === 6 && r[2] <= 61));
        assert.deepEqual(reports.flatMap(r => decoder.feed(r)), [message]);
    }
    assert.throws(() => encodeReports({ x: "a".repeat(4089) }), /4096/);
    const report = Buffer.alloc(64);
    const text = '{"a":1}{"b":2}';
    report.set([6, 2, text.length]); report.write(text, 3);
    assert.deepEqual(decoder.feed(report), [{ a: 1 }, { b: 2 }]);
});

test("Decoder rejects invalid frames, excessive depth and stale fragments, then recovers", () => {
    const decoder = new Decoder();
    assert.throws(() => decoder.feed(Buffer.alloc(63)), /Invalid HID/);
    const malformed = Buffer.alloc(64); malformed.set([6, 2, 62]);
    assert.throws(() => decoder.feed(malformed), /Invalid HID/);
    const partial = encodeReports({ x: "a".repeat(100) });
    decoder.feed(partial[0], 1);
    assert.throws(() => decoder.feed(partial[1], 1002), /timed out/);
    let deep = {};
    for (let i = 0; i < 33; i++) deep = { deep };
    assert.throws(() => encodeReports(deep).flatMap(r => decoder.feed(r)), /nesting/);
    assert.deepEqual(encodeReports({ ok: true }).flatMap(r => decoder.feed(r)), [{ ok: true }]);
});

test("Configuration requires six unique explicit slots and safe actions", () => {
    assert.equal(validateConfig({}).slots.length, 6);
    assert.equal(validateConfig({}).transport, "usb");
    assert.equal(validateConfig({ transport: "bluetooth" }).transport, "bluetooth");
    assert.throws(() => validateConfig({ transport: "auto" }), /transport/);
    for (const slots of [[], ["a"], ["a", "a", null, null, null, null],
        ["", null, null, null, null, null]]) {
        assert.throws(() => validateConfig({ slots }));
    }
    for (const value of [{ brightness: NaN }, { pollMs: 10 }, { keys: [] },
        { keys: { ACT06: "approve" } }, { keys: { BAD: "next" } }, { extra: true }])
        assert.throws(() => validateConfig(value));
});

test("Only key down and active joystick generate allowed actions", () => {
    for (let slot = 0; slot < 6; slot++) {
        const params = { k: `AG0${slot}`, ag: slot, act: 1 };
        assert.deepEqual(eventAction({ method: "v.oai.hid", params }, DEFAULT_CONFIG),
            { action: "slot", slot });
        params.act = 0;
        assert.equal(eventAction({ method: "v.oai.hid", params }, DEFAULT_CONFIG), null);
    }
    assert.throws(() => eventAction({ method: "v.oai.hid",
        params: { k: "AG00", ag: 1, act: 1 } }, DEFAULT_CONFIG), /mismatch/);
    for (const [a, action] of [[0, "next"], [0.25, "status"], [0.5, "previous"], [0.75, "attention"]]) {
        assert.deepEqual(eventAction({ method: "v.oai.rad", params: { a, d: 1 } }, DEFAULT_CONFIG), { action });
        assert.equal(eventAction({ method: "v.oai.rad", params: { a, d: 0 } }, DEFAULT_CONFIG), null);
    }
    assert.equal(eventAction({ method: "v.oai.hid", params: { k: "TOUCH", act: 1 } }, DEFAULT_CONFIG), null);
    for (const key of Object.keys(DEFAULT_CONFIG.keys).filter(k => !k.startsWith("JOY"))) {
        assert.equal(eventAction({ method: "v.oai.hid", params: { k: key, act: 1 } }, DEFAULT_CONFIG).action,
            DEFAULT_CONFIG.keys[key]);
    }
});

test("Stock firmware rotation act=2 is accepted only for encoder directions", () => {
    for (const [k, action] of [["ENC_CW", "next"], ["ENC_CC", "previous"]]) {
        for (const act of [1, 2])
            assert.deepEqual(eventAction({ method: "v.oai.hid", params: { k, act } }, DEFAULT_CONFIG), { action });
        assert.equal(eventAction({ method: "v.oai.hid", params: { k, act: 0 } }, DEFAULT_CONFIG), null);
    }
    for (const k of ["AG00", "ACT09", "ENC"])
        assert.equal(eventAction({ method: "v.oai.hid", params: { k, act: 2, ag: 0 } }, DEFAULT_CONFIG), null);
});

const sessions = [
    { id: "a", project_id: "project-a", is_running: true, activity: { status: "busy" } },
    { id: "b", is_running: true, awaiting_user_input: true, activity: { status: "busy" } },
    { id: "c", is_running: true, activity: { status: "idle" } },
    { id: "d", is_running: false, activity: { status: "idle" } },
];
const slots = ["a", null, "b", "c", "d", "missing"];

test("Completed App turn stays green when is_running becomes false", () => {
    const bound = ["a", null, null, null, null, null];
    const busy = { id: "a", is_running: true, activity: { status: "busy" } };
    const finished = { ...busy, is_running: false, activity: { status: "idle" } };
    assert.equal(lightsFor(bound, [busy], 0.25)[0].c, 0x0088ff);
    assert.equal(sessionState(finished), "idle");
    assert.deepEqual(lightsFor(bound, [finished], 0.25)[0],
        { id: 0, c: 0x00cc66, e: "solid", b: 0.25, s: 0.5 });
});

test("Lights preserve fixed slots and distinguish explicit idle from unavailable activity", () => {
    assert.equal(sessionState(sessions[0]), "running");
    assert.equal(sessionState(sessions[1]), "waiting");
    assert.equal(sessionState({ awaiting_plan_approval: true }), "waiting");
    assert.equal(sessionState(sessions[2]), "idle");
    assert.equal(sessionState(sessions[3]), "idle");
    assert.equal(sessionState({ activity: { status: "idle" } }), "idle");
    assert.equal(sessionState({ is_running: false }), "offline");
    assert.equal(sessionState({ is_running: true, activity: { status: "unknown" } }), "unknown");
    assert.equal(sessionState({ is_running: false, activity: { status: "busy" } }), "running");
    assert.equal(sessionState({ is_running: false, awaiting_user_input: true,
        activity: { status: "idle" } }), "waiting");
    assert.equal(sessionState({ is_running: false, activity: { status: "error" } }), "error");
    assert.equal(sessionState({ activity: { status: "failed" } }), "error");
    assert.equal(sessionState({ was_interrupted: true }), "unknown");
    const lights = lightsFor(slots, [...sessions].reverse(), 0.25);
    assert.equal(lights.length, 6);
    assert.deepEqual(lights.map(l => l.c), [0x0088ff, 0, 0xffaa00, 0x00cc66, 0x00cc66, 0x303030]);
    assert.deepEqual(lights.map(l => l.id), [0, 1, 2, 3, 4, 5]);
    const stale = lightsFor(slots, sessions, 0.25, true);
    assert.equal(stale[0].c, 0x8050ff); assert.equal(stale[1].c, 0);
});

test("Cycling skips empty slots without reassigning them", () => {
    assert.equal(nextSlot(slots, null, 1), 0);
    assert.equal(nextSlot(slots, null, -1), 5);
    assert.equal(nextSlot(slots, 0, 1), 2);
    assert.equal(nextSlot(slots, 0, -1), 5);
    assert.equal(nextSlot(slots, 0, 1, id => id === "b"), 2);
    assert.throws(() => nextSlot(slots, 0, 1, () => false), /No matching/);
});

test("App adapter uses native tools and refuses errors or invalid snapshots", async () => {
    const calls = [];
    const session = { rpc: { tools: { execute: async request => {
        calls.push(request);
        return { resultType: "success", textResultForLlm: JSON.stringify({ sessions }) };
    } } } };
    assert.deepEqual(await readSessions(session), sessions);
    assert.deepEqual(calls, [{ name: "get_sessions_status", arguments: {} }]);
    session.rpc.tools.execute = async () => ({ resultType: "denied", textResultForLlm: "Permission denied" });
    await assert.rejects(callApp(session, "navigate_to", { id: "a" }), /Permission denied/);
    assert.throws(() => parseSnapshot({ sessions: [{ id: "a" }, { id: "a" }] }));
    assert.throws(() => parseSnapshot({ sessions: [{ status: "busy" }] }));
});

test("USB filtering excludes Bluetooth with identical VID, PID and usage", () => {
    const device = { vendorId: 0x303a, productId: 0x8360, usagePage: 0xff00, usage: 1,
        path: "\\\\?\\HID#VID_303A&PID_8360&MI_02&Col02#example" };
    assert.equal(isUsbMicro(device), true);
    assert.equal(isUsbMicro({ ...device, path: "\\\\?\\HID#{00001812}_Dev_VID&02303a_PID&8360" }), false);
    assert.equal(isUsbMicro({ ...device, usagePage: 1 }), false);
});

test("Firmware handshake accepts Basic codex and the observed production version only", () => {
    assert(supportedFirmware({ example: "codex", firmwareFamily: "basic" }));
    const stock = { version: "0.1.37-ai-micro-idf-nimble",
        protocol: "codex-micro-hid", hardware_revision: "Board3" };
    assert(supportedFirmware(stock));
    assert.equal(supportedFirmware({ ...stock, version: "0.1.38-ai-micro-idf-nimble" }), false);
    assert.equal(supportedFirmware({ ...stock, protocol: "unknown" }), false);
    assert.equal(supportedFirmware({ example: "keyboard", firmwareFamily: "basic" }), false);
    assert.equal(supportedFirmware(null), false);
});

const usbDevice = { vendorId: 0x303a, productId: 0x8360, usagePage: 0xff00, usage: 1,
    serialNumber: "USB-SERIAL", path: "\\\\?\\HID#VID_303A&PID_8360&MI_02&Col01#test" };
const bleDevice = { ...usbDevice, serialNumber: "BLE-SERIAL",
    path: "\\\\?\\HID#{00001812-0000-1000-8000-00805f9b34fb}_Dev_VID&02303a_PID&8360_REV&0101_abc&Col02#test" };

test("Explicit transport selection never falls back, mixes identities, or guesses among devices", () => {
    assert.equal(deviceTransport(usbDevice), "usb");
    assert.equal(deviceTransport(bleDevice), "bluetooth");
    assert.equal(deviceTransport({ ...bleDevice, usagePage: 1, usage: 6 }), null);
    assert.equal(deviceTransport({ ...bleDevice, vendorId: 123 }), null);
    assert.equal(deviceTransport({ ...bleDevice, path: "unrecognized" }), null);
    const devices = [usbDevice, bleDevice];
    assert.equal(selectDevice(devices), usbDevice);
    assert.equal(selectDevice(devices, { transport: "bluetooth" }), bleDevice);
    assert.throws(() => selectDevice([usbDevice], { transport: "bluetooth" }), /found 0/);
    assert.throws(() => selectDevice(devices, { transport: "bluetooth", serialNumber: "USB-SERIAL" }), /found 0/);
    assert.throws(() => selectDevice([...devices, { ...bleDevice, serialNumber: "OTHER" }],
        { transport: "bluetooth" }), /found 2/);
    assert.equal(selectDevice([...devices, { ...bleDevice, serialNumber: "OTHER" }],
        { transport: "bluetooth", serialNumber: "BLE-SERIAL" }), bleDevice);
});

class FakeDevice extends EventEmitter {
    constructor() { super(); this.requests = []; this.closed = false; }
    async request(method, params) { this.requests.push({ method, params }); return true; }
    async close() { this.closed = true; }
}
function harness(options = {}) {
    const device = new FakeDevice(), calls = [], saved = [], logs = [];
    const controller = new Controller({
        config: { slots: ["a", null, "b", "c", "d", null], pollMs: 30000 },
        readSessions: async () => sessions,
        call: async (name, args) => { calls.push({ name, args }); },
        navigate: async id => { calls.push({ name: "open-session-url", args: { id } }); },
        open: async () => device, save: async config => { saved.push(config); },
        log: (message, level) => logs.push({ message, level }),
        ...options,
    });
    return { controller, device, calls, saved, logs };
}

test("Five minutes without hardware input turns off only background lights while Agent LEDs keep updating", async () => {
    let now = 0, current = sessions;
    const { controller, device, saved } = harness({
        now: () => now, readSessions: async () => current,
    });
    const background = () => device.requests.filter(r => r.method === "v.oai.rgbcfg");
    await controller.start();
    try {
        now = 299999;
        await controller.tick();
        assert.equal(background().at(-1).params.ambient.b, 0.1);
        assert.equal(background().at(-1).params.keys.b, 0.1);
        now = 300000;
        await controller.tick();
        assert.deepEqual(background().at(-1).params, {
            ambient: { c: 0, b: 0, e: "off" }, keys: { c: 0, b: 0, e: "off" },
        });
        assert.equal(controller.status().backgroundIdle, true);
        assert.equal(device.requests.at(-1).params[0].c, 0x0088ff);
        assert.equal(device.requests.at(-1).params[0].b, 0.25);
        const count = background().length;
        current = [{ ...sessions[0], activity: { status: "idle" } }];
        now = 302000;
        await controller.tick();
        assert.equal(device.requests.at(-1).params[0].c, 0x00cc66);
        assert.equal(device.requests.at(-1).params[0].b, 0.25);
        assert.equal(background().length, count);
        assert.equal(saved.length, 0);
    } finally { await controller.stop(); }
});

test("Agent key navigates directly rather than returning an Open confirmation card", async () => {
    const { controller } = harness();
    const opened = [], cards = [];
    controller.navigate = async id => { opened.push(id); };
    controller.call = async (name, args) => { cards.push({ name, args }); return "Click Open to switch"; };
    await controller.start();
    try {
        await controller.perform({ action: "slot", slot: 0 });
        assert.deepEqual(opened, ["a"]);
        assert.deepEqual(cards, []);
    } finally { await controller.stop(); }
});

test("Hardware controls wake the background, execute once, and restart the idle interval", async () => {
    const controls = [
        [{ method: "v.oai.hid", params: { k: "AG00", ag: 0, act: 1 } }, "a"],
        [{ method: "v.oai.hid", params: { k: "ACT07", act: 1 } }, "b"],
        [{ method: "v.oai.hid", params: { k: "ENC_CW", act: 2 } }, "b"],
        [{ method: "v.oai.hid", params: { k: "ENC", act: 1 } }, "a"],
        [{ method: "v.oai.rad", params: { a: 0.75, d: 1 } }, "b"],
    ];
    for (const [message, target] of controls) {
        let now = 0;
        const { controller, device, calls } = harness({ now: () => now });
        await controller.start();
        try {
            device.emit("input", { method: "v.oai.hid", params: { k: "AG00", ag: 0, act: 1 } });
            await controller.queue;
            now = 300000;
            await controller.tick();
            const count = calls.length;
            now = 300001;
            device.emit("input", message);
            await controller.queue;
            assert.equal(controller.status().backgroundIdle, false);
            const background = device.requests.filter(r => r.method === "v.oai.rgbcfg").at(-1);
            assert.equal(background.params.ambient.b, 0.1);
            assert.equal(background.params.keys.b, 0.1);
            assert.deepEqual(calls.slice(count), [{ name: "open-session-url", args: { id: target } }]);
            now = 600000;
            await controller.tick();
            assert.equal(controller.status().backgroundIdle, false);
            now = 600001;
            await controller.tick();
            assert.equal(controller.status().backgroundIdle, true);
        } finally { await controller.stop(); }
    }
});

test("Controller routes six-key events, waiting navigation, brightness and idle workspace creation", async () => {
    const { controller, device, calls, saved } = harness();
    await controller.start();
    try {
        device.emit("input", { method: "v.oai.hid", params: { k: "AG00", ag: 0, act: 1 } });
        await controller.queue;
        assert.deepEqual(calls[0], { name: "open-session-url", args: { id: "a" } });
        await controller.perform({ action: "new-session" });
        assert.deepEqual(calls[1], { name: "create_session",
            args: { project_id: "project-a", name: "AI Micro session", coordinate_with_creator: false } });
        assert(!("kickoff" in calls[1].args));
        await controller.perform({ action: "attention" });
        assert.equal(calls.at(-1).args.id, "b");
        await controller.perform({ action: "brightness" });
        assert.equal(saved.at(-1).brightness, 0.5);
        assert.equal(device.requests.at(-1).method, "v.oai.thstatus");
    } finally { await controller.stop(); }
    assert.equal(device.closed, true);
    assert(device.requests.at(-2).params.every(l => l.e === "off"));
});

test("Disabled controls still wake the background without App actions; releases and unknown inputs do not", async () => {
    let now = 0, reads = 0;
    const { controller, device, calls } = harness({
        now: () => now, readSessions: async () => { reads++; return sessions; },
    });
    await controller.configure({ keys: { ACT06: "none", JOY_RIGHT: "none" } });
    await controller.start();
    try {
        now = 299999;
        for (const params of [{ k: "AG00", ag: 0, act: 0 }, { k: "TOUCH", act: 1 },
            { k: "ACT06", act: 2 }]) {
            device.emit("input", { method: "v.oai.hid", params });
        }
        device.emit("input", { method: "v.oai.rad", params: { a: 0, d: 0 } });
        await controller.queue;
        now = 300000;
        await controller.tick();
        assert.equal(controller.status().backgroundIdle, true);
        for (const message of [
            { method: "v.oai.hid", params: { k: "ACT06", act: 1 } },
            { method: "v.oai.rad", params: { a: 0, d: 1 } },
        ]) {
            const before = reads;
            device.emit("input", message);
            await controller.queue;
            assert.equal(controller.status().backgroundIdle, false);
            assert.equal(reads, before);
            assert.equal(calls.length, 0);
            now += 300000;
            await controller.tick();
            assert.equal(controller.status().backgroundIdle, true);
        }
    } finally { await controller.stop(); }
});

test("Stale app state paints unknown and blocks actions without losing bindings", async () => {
    const { controller, device, calls } = harness();
    await controller.start();
    try {
        controller.readSessions = async () => { throw new Error("App unavailable"); };
        await controller.tick();
        assert.equal(controller.status().stale, true);
        assert.equal(device.requests.at(-1).params[0].c, 0x8050ff);
        await assert.rejects(controller.perform({ action: "slot", slot: 0 }), /unavailable/);
        assert.equal(calls.length, 0);
        assert.equal(controller.config.slots[0], "a");
    } finally { await controller.stop(); }
});

test("Live polling repaints blue to green after completion, then yellow for user input", async () => {
    const { controller, device } = harness();
    await controller.start();
    try {
        assert.equal(device.requests.at(-1).params[0].c, 0x0088ff);
        controller.readSessions = async () => [
            { ...sessions[0], is_running: false, activity: { status: "idle" } },
        ];
        await controller.tick();
        assert.equal(controller.status().slots[0].state, "idle");
        assert.equal(device.requests.at(-1).params[0].c, 0x00cc66);
        assert.equal(device.requests.at(-1).params[0].e, "solid");
        controller.readSessions = async () => [
            { ...sessions[0], is_running: false, awaiting_user_input: true,
                activity: { status: "idle" } },
        ];
        await controller.tick();
        assert.equal(controller.status().slots[0].state, "waiting");
        assert.equal(device.requests.at(-1).params[0].c, 0xffaa00);
        controller.readSessions = async () => [
            { ...sessions[0], is_running: false, activity: { status: "error" } },
        ];
        await controller.tick();
        assert.equal(controller.status().slots[0].state, "error");
        assert.equal(device.requests.at(-1).params[0].c, 0xff3030);
    } finally { await controller.stop(); }
});

test("Failed navigation never changes selected slot; missing bindings never fall back", async () => {
    const { controller, calls } = harness();
    await controller.start();
    try {
        await assert.rejects(controller.perform({ action: "slot", slot: 1 }), /not bound/);
        assert.equal(calls.length, 0);
        controller.navigate = async () => { throw new Error("Navigation denied"); };
        await assert.rejects(controller.perform({ action: "slot", slot: 0 }), /denied/);
        assert.equal(controller.selected, null);
        controller.readSessions = async () => [];
        await assert.rejects(controller.perform({ action: "slot", slot: 0 }), /unavailable/);
    } finally { await controller.stop(); }
});

test("Configuration is validated and persisted before applying; USB changes require stop", async () => {
    const { controller, saved } = harness();
    await assert.rejects(controller.configure({ keys: [] }), /keys must be/);
    await assert.rejects(controller.configure({ slots: ["missing", null, null, null, null, null] }), /not found/);
    assert.equal(saved.length, 0);
    await controller.configure({ brightness: 0.1 });
    assert.equal(saved.length, 1);
    await controller.start();
    try {
        await assert.rejects(controller.configure({ serialNumber: "other" }), /Stop/);
        await assert.rejects(controller.configure({ transport: "bluetooth" }), /Stop/);
        controller.save = async () => { throw new Error("Disk full"); };
        await assert.rejects(controller.configure({ brightness: 0.5 }), /Disk full/);
        assert.equal(controller.config.brightness, 0.1);
    } finally { await controller.stop(); }
});

test("Idle timeout can be configured live or disabled without changing brightness or resetting on bindings", async () => {
    let now = 0;
    const { controller, device, saved } = harness({ now: () => now });
    await controller.start();
    try {
        assert.equal(controller.status().backgroundIdleMs, 300000);
        await controller.configure({ backgroundIdleMs: 1000 });
        assert.equal(saved.at(-1).backgroundIdleMs, 1000);
        now = 999;
        await controller.tick();
        assert.equal(controller.status().backgroundIdle, false);
        now = 1000;
        await controller.tick();
        assert.equal(controller.status().backgroundIdle, true);
        await controller.configure({ brightness: 0.5 });
        await controller.bind(1, null);
        assert.equal(controller.status().backgroundIdle, true);
        assert.equal(saved.at(-1).brightness, 0.5);
        assert.equal(saved.at(-1).backgroundIdleMs, 1000);
        const background = () => device.requests.filter(r => r.method === "v.oai.rgbcfg").at(-1).params;
        assert.equal(background().ambient.b, 0);
        await controller.configure({ backgroundIdleMs: 0 });
        assert.equal(background().ambient.b, 0.2);
        assert.equal(background().keys.b, 0.2);
        assert.equal(controller.status().backgroundIdle, false);
        now = 86400000;
        await controller.tick();
        assert.equal(controller.status().backgroundIdle, false);
        const count = saved.length;
        for (const backgroundIdleMs of [-1, 0.5, 86400001, null, "1000"]) {
            await assert.rejects(controller.configure({ backgroundIdleMs }), /backgroundIdleMs/);
        }
        assert.equal(saved.length, count);
        assert.equal(saved.at(-1).backgroundIdleMs, 0);
    } finally { await controller.stop(); }
});

test("Binding one key applies immediately and preserves all other keys and connection settings", async () => {
    const { controller, device, calls, saved } = harness();
    controller.readSessions = async () => [...sessions, { id: "new", activity: { status: "idle" } }];
    await controller.configure({ transport: "bluetooth", serialNumber: "BLE-SERIAL" });
    await controller.start();
    try {
        const original = [...controller.config.slots];
        await controller.bind(2, "new");
        assert.deepEqual(controller.config.slots, [original[0], "new", ...original.slice(2)]);
        assert.equal(saved.at(-1).transport, "bluetooth");
        assert.equal(saved.at(-1).serialNumber, "BLE-SERIAL");
        assert.equal(controller.status().slots[1].state, "idle");
        assert.equal(device.requests.at(-1).params[1].c, 0x00cc66);
        await controller.perform({ action: "slot", slot: 1 });
        assert.equal(calls.at(-1).args.id, "new");
        await controller.bind(2, null);
        assert.equal(device.requests.at(-1).params[1].e, "off");
        assert.equal(controller.selected, null);
        await assert.rejects(controller.bind(2, "a"), /Duplicate/);
        await assert.rejects(controller.bind(2, "missing"), /not found/);
        await assert.rejects(controller.bind(0, "new"), /1 to 6/);
        await assert.rejects(controller.bind(7, "new"), /1 to 6/);
        await assert.rejects(controller.bind(2, undefined), /sessionId/);
        const beforeFailure = [...controller.config.slots];
        controller.save = async () => { throw new Error("Disk full"); };
        await assert.rejects(controller.bind(2, "new"), /Disk full/);
        assert.deepEqual(controller.config.slots, beforeFailure);
    } finally { await controller.stop(); }
});

test("Concurrent single-slot binding changes do not overwrite each other", async () => {
    const { controller } = harness();
    controller.readSessions = async () => [...sessions, { id: "e" }, { id: "f" }];
    await Promise.all([controller.bind(2, "e"), controller.bind(6, "f")]);
    assert.deepEqual(controller.config.slots, ["a", "e", "b", "c", "d", "f"]);
});

test("Bluetooth reconnect pins the original device and applies bindings saved while disconnected", async () => {
    const { controller, device, calls } = harness();
    device.info = { transport: "bluetooth", serialNumber: "BLE-SERIAL", version: "test" };
    const opened = [];
    const replacement = new FakeDevice();
    replacement.info = device.info;
    let attempts = 0;
    controller.open = async options => {
        opened.push(options);
        if (attempts++ === 0) return device;
        return replacement;
    };
    await controller.configure({ transport: "bluetooth" });
    await controller.start();
    try {
        device.emit("fault", new Error("Bluetooth disconnected"));
        await assert.rejects(controller.perform({ action: "slot", slot: 0 }), /disconnected/);
        assert.equal(calls.length, 0);
        await controller.bind(1, null);
        await controller.bind(2, "a");
        await controller.tick();
        assert.deepEqual(opened, [
            { transport: "bluetooth", serialNumber: null },
            { transport: "bluetooth", serialNumber: "BLE-SERIAL" },
        ]);
        assert.equal(replacement.requests.at(-1).params[0].e, "off");
        assert.equal(replacement.requests.at(-1).params[1].c, 0x0088ff);
        assert.equal(controller.status().connected, true);
        assert.equal(controller.status().serialNumber, "BLE-SERIAL");
    } finally { await controller.stop(); }
});

test("Reconnect restores idle lighting without a flash and ignores input from the old connection", async () => {
    let now = 0;
    const replacement = new FakeDevice();
    const device = new FakeDevice();
    let attempts = 0;
    const { controller, calls } = harness({
        now: () => now, open: async () => attempts++ === 0 ? device : replacement,
    });
    await controller.start();
    try {
        now = 300000;
        await controller.tick();
        device.emit("fault", new Error("Bluetooth disconnected"));
        now = 400000;
        await controller.tick();
        assert.equal(controller.status().connected, true);
        assert.equal(controller.status().backgroundIdle, true);
        const background = replacement.requests.filter(r => r.method === "v.oai.rgbcfg");
        assert.equal(background.length, 1);
        assert.equal(background[0].params.ambient.e, "off");
        assert.equal(background[0].params.keys.b, 0);
        assert.equal(replacement.requests.at(-1).params[0].b, 0.25);
        const key = { method: "v.oai.hid", params: { k: "AG00", ag: 0, act: 1 } };
        device.emit("input", key);
        await controller.queue;
        await controller.tick();
        assert.equal(controller.status().backgroundIdle, true);
        assert.equal(calls.length, 0);
        replacement.emit("input", key);
        await controller.queue;
        assert.equal(controller.status().backgroundIdle, false);
        assert.deepEqual(calls, [{ name: "open-session-url", args: { id: "a" } }]);
    } finally { await controller.stop(); }
});

test("Wake failures are explicit and reconnect retries lighting without replaying the action", async () => {
    let now = 0, rejectWrites = false;
    const device = new FakeDevice();
    const request = device.request.bind(device);
    device.request = async (...args) => {
        if (rejectWrites) throw new Error("Wake light write failed");
        return request(...args);
    };
    const replacement = new FakeDevice();
    let attempts = 0;
    const { controller, calls, logs } = harness({
        now: () => now, open: async () => attempts++ === 0 ? device : replacement,
    });
    await controller.start();
    try {
        now = 300000;
        await controller.tick();
        rejectWrites = true;
        device.emit("input", { method: "v.oai.hid", params: { k: "AG00", ag: 0, act: 1 } });
        await controller.queue;
        assert.equal(controller.status().connected, false);
        assert(logs.some(({ message }) => message.includes("Wake light write failed")));
        assert.equal(calls.length, 0);
        await controller.tick();
        assert.equal(controller.status().connected, true);
        assert.equal(controller.status().backgroundIdle, false);
        assert.equal(replacement.requests[0].params.ambient.b, 0.1);
        assert.equal(calls.length, 0);
    } finally { await controller.stop(); }
});

test("Wake respects zero brightness and works even when App status is unavailable", async () => {
    let now = 0, unavailable = false;
    const { controller, device, calls, logs } = harness({
        now: () => now, readSessions: async () => {
            if (unavailable) throw new Error("App unavailable");
            return sessions;
        },
    });
    await controller.configure({ brightness: 0 });
    await controller.start();
    try {
        now = 300000;
        await controller.tick();
        unavailable = true;
        device.emit("input", { method: "v.oai.hid", params: { k: "AG00", ag: 0, act: 1 } });
        await controller.queue;
        assert.equal(controller.status().backgroundIdle, false);
        const background = device.requests.filter(r => r.method === "v.oai.rgbcfg").at(-1).params;
        assert.equal(background.ambient.b, 0);
        assert.equal(background.keys.b, 0);
        assert.equal(calls.length, 0);
        assert(logs.some(({ message }) => message.includes("App unavailable")));
        now = 600000;
        await controller.tick();
        assert.equal(controller.status().backgroundIdle, true);
        assert.equal(controller.status().stale, true);
    } finally { await controller.stop(); }
});

test("A saved binding is not lost when the subsequent device update fails", async () => {
    const { controller, device, saved } = harness();
    await controller.start();
    try {
        device.request = async () => { throw new Error("Bluetooth unavailable"); };
        await assert.rejects(controller.bind(1, null), /Configuration saved; device sync failed/);
        assert.equal(controller.config.slots[0], null);
        assert.equal(saved.at(-1).slots[0], null);
        assert.equal(controller.status().connected, false);
        const replacement = new FakeDevice();
        controller.open = async () => replacement;
        await controller.tick();
        assert.equal(replacement.requests.at(-1).params[0].e, "off");
    } finally { await controller.stop(); }
});

test("An event queued on an old connection is never replayed on its replacement", async () => {
    const { controller, device, calls, logs } = harness();
    await controller.start();
    try {
        let release;
        const gate = new Promise(resolve => { release = resolve; });
        controller.enqueue(() => gate);
        controller.enqueue(() => controller.tick());
        device.emit("input", { method: "v.oai.hid", params: { k: "AG00", ag: 0, act: 1 } });
        device.emit("fault", new Error("Bluetooth disconnected"));
        controller.open = async () => new FakeDevice();
        release();
        await controller.queue;
        assert.equal(calls.length, 0);
        assert(logs.some(({ message }) => message.includes("Connection changed")));
    } finally { await controller.stop(); }
});

test("Disconnect while refreshing App state prevents navigation", async () => {
    const { controller, device, calls } = harness();
    await controller.start();
    try {
        controller.readSessions = async () => {
            device.emit("fault", new Error("Bluetooth disconnected"));
            return sessions;
        };
        await assert.rejects(controller.perform({ action: "slot", slot: 0 }), /during status refresh/);
        assert.equal(calls.length, 0);
    } finally { await controller.stop(); }
});

test("Start refuses unbound configuration and missing hardware without scheduling", async () => {
    const { controller } = harness();
    controller.config.slots.fill(null);
    await assert.rejects(controller.start(), /Bind at least/);
    controller.config.slots[0] = "a";
    controller.open = async () => { throw new Error("No USB device"); };
    await assert.rejects(controller.start(), /No USB/);
    assert.equal(controller.running, false);
    assert.equal(controller.device, null);
    assert.equal(controller.timer, undefined);
});

test("Queue overflow is explicit but never blocks shutdown", async () => {
    const { controller } = harness();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const queued = Array.from({ length: 16 }, () => controller.enqueue(() => gate));
    await assert.rejects(controller.enqueue(() => {}), /queue full/);
    const stopped = controller.stop();
    release();
    await Promise.all([...queued, stopped]);
    assert.equal(controller.queued, 0);
});

test("Updating brightness repaints command, ambient and all Agent lights", async () => {
    const { controller, device } = harness();
    await controller.start();
    try {
        await controller.configure({ brightness: 0.5 });
        assert.equal(device.requests.at(-2).params.ambient.b, 0.2);
        assert.equal(device.requests.at(-2).params.keys.b, 0.2);
        assert(device.requests.at(-1).params.every(light => light.b === 0.5));
    } finally { await controller.stop(); }
});

test("Disconnect closes old device, reconnects, and reapplies all six lights", async () => {
    const { controller, device } = harness();
    await controller.start();
    const replacement = new FakeDevice();
    controller.open = async () => replacement;
    try {
        device.emit("fault", new Error("Unplugged"));
        await controller.tick();
        assert(device.closed);
        assert.equal(controller.device, replacement);
        assert.equal(replacement.requests.at(-1).params.length, 6);
        assert(controller.status().connected);
    } finally { await controller.stop(); }
});

test("Stopping during startup leaves no timer or active connection", async () => {
    const { controller, device } = harness();
    const start = controller.start();
    const stop = controller.stop();
    await Promise.all([start, stop]);
    assert.equal(controller.running, false);
    assert.equal(controller.device, null);
    assert(device.closed);
});

class FakeHid extends EventEmitter {
    constructor() { super(); this.decoder = new Decoder(); this.requests = []; }
    async write(report) {
        for (const request of this.decoder.feed(Buffer.from(report))) {
            this.requests.push(request);
            queueMicrotask(() => {
                const reply = this.reply ? this.reply(request) :
                    request.method === "fail" ? { id: request.id, error: { code: -32601 } } :
                    { id: request.id, result: request.params ?? true };
                for (const data of encodeReports(reply)) this.emit("data", data);
            });
        }
        return report.length;
    }
    async close() { this.closed = true; }
}

test("USB and Bluetooth handshake reuse Windows Report 6 and verify the actual transport", async () => {
    for (const transport of ["usb", "bluetooth"]) {
        const raw = new FakeHid();
        raw.reply = request => ({ id: request.id, result: request.method === "device.status" ? {
            version: "0.1.37-ai-micro-idf-nimble", protocol: "codex-micro-hid",
            hardware_revision: "Board3", active_transport: transport === "usb" ? "usb" : "ble",
            ble_connected: transport === "bluetooth",
        } : true });
        const backend = { devicesAsync: async () => [usbDevice, bleDevice],
            HIDAsync: { open: async path => {
                assert.equal(path, transport === "usb" ? usbDevice.path : bleDevice.path);
                return raw;
            } } };
        const hid = await MicroHid.open({ transport }, backend);
        assert.equal(hid.info.transport, transport);
        assert.equal(hid.info.serialNumber, transport === "usb" ? "USB-SERIAL" : "BLE-SERIAL");
        assert.deepEqual(raw.requests.map(r => r.method), ["device.status", "v.oai.thstatus"]);
        await hid.close();
    }
    const raw = new FakeHid();
    raw.reply = request => ({ id: request.id, result: {
        version: "0.1.37-ai-micro-idf-nimble", protocol: "codex-micro-hid",
        hardware_revision: "Board3", active_transport: "usb", ble_connected: false,
    } });
    await assert.rejects(MicroHid.open({ transport: "bluetooth" }, {
        devicesAsync: async () => [bleDevice], HIDAsync: { open: async () => raw },
    }), /active bluetooth/);
    assert(raw.closed);
});

test("HID requests serialize fragments, correlate replies and propagate firmware failures", async () => {
    const raw = new FakeHid(), hid = new MicroHid(raw);
    try {
        const values = [{ text: "x".repeat(200) }, { text: "y".repeat(200) }];
        assert.deepEqual(await Promise.all(values.map(v => hid.request("echo", v))), values);
        assert.deepEqual(raw.requests.map(r => r.id), [1, 2]);
        await assert.rejects(hid.request("fail"), /Firmware/);
        raw.write = async () => 0;
        await assert.rejects(hid.request("echo"), /Short HID write/);
    } finally { await hid.close(); }
    assert(raw.closed);
});

test("HID request timeout and device error reject pending requests explicitly", async () => {
    const raw = new FakeHid(), hid = new MicroHid(raw);
    hid.on("fault", () => {});
    raw.write = async report => report.length;
    try {
        await assert.rejects(hid.request("unanswered"), /timed out/);
        const pending = hid.request("disconnected");
        raw.emit("error", new Error("USB disconnected"));
        await assert.rejects(pending, /USB disconnected/);
        assert.equal(hid.pending.size, 0);
    } finally { await hid.close(); }
});

test("Native HID string errors remain readable during Bluetooth disconnection", async () => {
    const raw = new FakeHid(), hid = new MicroHid(raw), faults = [];
    hid.on("fault", error => faults.push(error));
    raw.write = async report => report.length;
    try {
        const pending = hid.request("pending");
        raw.emit("error", "Bluetooth read failed");
        await assert.rejects(pending, error => error instanceof Error && error.message === "Bluetooth read failed");
        assert.equal(faults[0].message, "Bluetooth read failed");
    } finally { await hid.close(); }
});

test("Direct navigation opens the exact App-provided URL, never constructs or substitutes one", async () => {
    const id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const url = "ghapp://sessions/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const items = [{ id, app_url: url }];
    for (const input of [items, JSON.stringify(items), `Found 1 item(s):\n${JSON.stringify(items)}`])
        assert.equal(sessionUrl(input, id), url);
    for (const invalid of ["https://example.com", "ghapp://settings", `${url}?x=1`,
        `${url};calc.exe`, `${url}/`, "file:///C:/Windows"]) {
        assert.throws(() => sessionUrl([{ id, app_url: invalid }], id));
    }
    assert.throws(() => sessionUrl([], id), /missing/);
    assert.throws(() => sessionUrl([...items, ...items], id), /ambiguous/);
    assert.throws(() => sessionUrl([{ id, app_url: url.replace("eeeeeeeeeeee", "ffffffffffff") }], id), /invalid/);
    const calls = [], opened = [];
    const session = { rpc: { tools: { execute: async request => {
        calls.push(request);
        return { resultType: "success", textResultForLlm: `Found 1 item(s):\n${JSON.stringify(items)}` };
    } } } };
    await navigateSession(session, id, async target => { opened.push(target); });
    assert.deepEqual(opened, [url]);
    assert.deepEqual(calls, [{ name: "list_sessions_and_chats", arguments: {} }]);
    await assert.rejects(navigateSession(session, id, async () => { throw new Error("No URI handler"); }), /No URI handler/);
});

test("Agent navigation reads the full saved App catalogue instead of parsing an oversized-output notice", async () => {
    const id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const url = `ghapp://sessions/${id}`;
    const path = join(tmpdir(), `${Date.now()}-copilot-tool-output-${randomUUID().replaceAll("-", "")}.txt`);
    const items = Array.from({ length: 56 }, (_, index) => ({
        id: `other-${index}`, name: "Large catalogue ".repeat(40),
    }));
    items.push({ id, app_url: url });
    const notice = `Output too large to read at once (20.0 KB). Saved to: ${path}\nConsider using tools like rg.\n\nPreview (first 500 chars):\nFound 57 item(s):\n[`;
    await writeFile(path, `Found 57 item(s):\n${JSON.stringify(items)}`);
    try {
        const opened = [];
        for (const result of [notice, { resultType: "success", textResultForLlm: notice }]) {
            const session = { rpc: { tools: { execute: async () => result } } };
            await navigateSession(session, id, async value => opened.push(value));
        }
        assert.deepEqual(opened, [url, url]);
        await writeFile(path, JSON.stringify({ sessions }));
        const session = { rpc: { tools: { execute: async () => ({
            resultType: "success", textResultForLlm: notice,
        }) } } };
        assert.deepEqual(await readSessions(session), sessions);
    } finally { await unlink(path); }
});

test("Saved App output preserves structured-result priority and rejects invalid, missing or excessive files", async () => {
    const path = join(tmpdir(), `${Date.now()}-copilot-tool-output-${randomUUID().replaceAll("-", "")}.txt`);
    const notice = path => `Output too large to read at once (20.0 KB). Saved to: ${path}\nPreview:\n[]`;
    const session = result => ({ rpc: { tools: { execute: async () => result } } });
    assert.deepEqual(await callApp(session({
        resultType: "success", structuredContent: sessions, textResultForLlm: notice(path),
    }), "list_sessions_and_chats"), sessions);
    await assert.rejects(callApp(session({
        resultType: "failure", textResultForLlm: notice(path),
    }), "list_sessions_and_chats"), /list_sessions_and_chats:/);
    await assert.rejects(callApp(session(notice(path)), "list_sessions_and_chats"), /cannot read saved App output/);
    for (const invalid of ["relative.txt", join(tmpdir(), "private-config.json"),
        join(tmpdir(), "copilot-tool-output-invalid.txt")]) {
        await assert.rejects(callApp(session(notice(invalid)), "list_sessions_and_chats"), /invalid saved App output path/);
    }
    await assert.rejects(callApp(session("Output too large to read at once"), "get_sessions_status"),
        /unsupported oversized App output notice/);
    const file = await openFile(path, "w");
    try { await file.truncate(16 * 1024 * 1024 + 1); }
    finally { await file.close(); }
    try {
        await assert.rejects(callApp(session(notice(path)), "get_sessions_status"), /no larger than 16 MiB/);
        const id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
        await writeFile(path, `Found 1 item(s):\n${JSON.stringify([{ id, app_url: "https://example.com" }])}`);
        let opened = false;
        await assert.rejects(navigateSession(session(notice(path)), id, async () => { opened = true; }),
            /invalid session URL/);
        assert.equal(opened, false);
    } finally { await unlink(path); }
});

test("Saved App output bounds actual reads when the file grows after stat", async t => {
    const limit = 16 * 1024 * 1024;
    const path = join(tmpdir(), `${Date.now()}-copilot-tool-output-${randomUUID().replaceAll("-", "")}.txt`);
    const writer = await openFile(path, "w+");
    try {
        await writer.writeFile("small");
        const identity = await writer.stat();
        const prototype = Object.getPrototypeOf(writer);
        const originalStat = prototype.stat, originalRead = prototype.read;
        let reader, bytesRead = 0;
        t.mock.method(prototype, "stat", async function (...args) {
            const stat = await originalStat.apply(this, args);
            if (stat.dev === identity.dev && stat.ino === identity.ino) {
                reader = this;
                await writer.truncate(limit + 65536);
            }
            return stat;
        });
        t.mock.method(prototype, "read", async function (...args) {
            const result = await originalRead.apply(this, args);
            if (this === reader) bytesRead += result.bytesRead;
            return result;
        });
        const session = { rpc: { tools: { execute: async () =>
            `Output too large to read at once (20.0 KB). Saved to: ${path}\n` } } };
        await assert.rejects(callApp(session, "get_sessions_status"), /no larger than 16 MiB/);
        assert.equal(bytesRead, limit + 1);
        assert.equal(reader.fd, -1);
    } finally {
        t.mock.restoreAll();
        await writer.close();
        await unlink(path);
    }
});

test("Saved App output accepts exactly 16 MiB and decodes UTF-8 across short reads", async t => {
    const limit = 16 * 1024 * 1024;
    const path = join(tmpdir(), `${Date.now()}-copilot-tool-output-${randomUUID().replaceAll("-", "")}.txt`);
    const writer = await openFile(path, "w+");
    try {
        const text = "a".repeat(65534) + "\u{1f990}" + "b".repeat(limit - 65538);
        await writer.writeFile(text);
        const prototype = Object.getPrototypeOf(writer);
        const originalRead = prototype.read;
        let bytesRead = 0;
        t.mock.method(prototype, "read", async function (buffer, offset, length, position) {
            const result = await originalRead.call(this, buffer, offset, Math.min(length, 65535), position);
            bytesRead += result.bytesRead;
            return result;
        });
        const session = { rpc: { tools: { execute: async () =>
            `Output too large to read at once (16.0 MB). Saved to: ${path}\n` } } };
        assert.equal(await callApp(session, "get_sessions_status"), text);
        assert.equal(bytesRead, limit);
        await writer.truncate(0);
        assert.equal(await callApp(session, "get_sessions_status"), "");
    } finally {
        t.mock.restoreAll();
        await writer.close();
        await unlink(path);
    }
});
