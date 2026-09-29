// SPDX-License-Identifier: MIT
import { EventEmitter } from "node:events";
import { Decoder, encodeReports } from "./core.mjs";

export function deviceTransport(device) {
    if (device.vendorId !== 0x303a || device.productId !== 0x8360 ||
        device.usagePage !== 0xff00 || device.usage !== 1) return null;
    const path = device.path ?? "";
    if (/^\\\\\?\\hid#vid_303a&pid_8360&mi_[0-9a-f]{2}(?:&|#)/i.test(path)) return "usb";
    if (/^\\\\\?\\hid#\{00001812-0000-1000-8000-00805f9b34fb\}_dev_vid&02303a_pid&8360_/i.test(path))
        return "bluetooth";
    return null;
}

export function isUsbMicro(device) { return deviceTransport(device) === "usb"; }

export function selectDevice(devices, { transport = "usb", serialNumber = null } = {}) {
    if (!["usb", "bluetooth"].includes(transport)) throw new Error("Unsupported HID transport");
    const matches = devices.filter(d => deviceTransport(d) === transport &&
        (serialNumber === null || d.serialNumber === serialNumber));
    if (matches.length !== 1)
        throw new Error(`Expected one ${transport} AI Micro vendor HID, found ${matches.length}; check connection and serialNumber`);
    if (!matches[0].serialNumber) throw new Error("Device has no stable serial identity");
    return matches[0];
}

export function supportedFirmware(status) {
    if (!status || typeof status !== "object") return false;
    return (status.example === "codex" && status.firmwareFamily === "basic") ||
        (status.version === "0.1.37-ai-micro-idf-nimble" &&
            status.protocol === "codex-micro-hid" && status.hardware_revision === "Board3");
}

export async function listDevices() {
    const { default: HID } = await import("node-hid");
    return (await HID.devicesAsync(0x303a, 0x8360))
        .filter(d => deviceTransport(d) !== null)
        .map(d => ({ ...d, transport: deviceTransport(d) }));
}

export class MicroHid extends EventEmitter {
    constructor(device) {
        super();
        this.device = device;
        this.decoder = new Decoder();
        this.pending = new Map();
        this.sequence = 0;
        this.writes = Promise.resolve();
        this.closed = false;
        device.on("data", report => {
            try {
                // Report 1 is a separate standard keyboard collection.
                if (report[0] !== 6) return;
                for (const message of this.decoder.feed(report)) {
                    if (Object.hasOwn(message, "id")) {
                        const pending = this.pending.get(message.id);
                        if (!pending) continue;
                        this.pending.delete(message.id); clearTimeout(pending.timer);
                        if (message.error) pending.reject(new Error(`Firmware: ${JSON.stringify(message.error)}`));
                        else if (Object.hasOwn(message, "result")) pending.resolve(message.result);
                        else pending.reject(new Error("Malformed firmware response"));
                    } else this.emit("input", message);
                }
            } catch (error) { this.emit("fault", error); }
        });
        device.on("error", error => {
            const cause = error instanceof Error ? error : new Error(String(error));
            this.rejectPending(cause);
            this.emit("fault", cause);
        });
    }
    static async open({ transport = "usb", serialNumber = null } = {}, backend) {
        const HID = backend ?? (await import("node-hid")).default;
        const device = selectDevice(await HID.devicesAsync(0x303a, 0x8360), { transport, serialNumber });
        const connection = new MicroHid(await HID.HIDAsync.open(device.path));
        try {
            const status = await connection.request("device.status");
            if (!supportedFirmware(status))
                throw new Error("Requires Basic codex or verified Board3 0.1.37 firmware; unsupported firmware identity");
            const active = transport === "bluetooth" ? "ble" : "usb";
            if (status.active_transport !== active || (transport === "bluetooth" && !status.ble_connected))
                throw new Error(`Firmware is not reporting an active ${transport} connection`);
            await connection.request("v.oai.thstatus", []);
            connection.info = { transport, serialNumber: device.serialNumber, version: status.version };
            return connection;
        } catch (error) {
            await connection.close();
            throw error;
        }
    }
    request(method, params) {
        if (this.closed) return Promise.reject(new Error("HID connection is closed"));
        const id = ++this.sequence;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`Firmware request timed out: ${method}`));
            }, 3000);
            this.pending.set(id, { resolve, reject, timer });
            const operation = this.writes.then(async () => {
                if (this.closed) throw new Error("HID connection is closed");
                for (const report of encodeReports({ id, method, ...(params === undefined ? {} : { params }) })) {
                    const count = await this.device.write([...report]);
                    if (count !== report.length) throw new Error(`Short HID write: ${count}/64`);
                }
            });
            this.writes = operation.catch(error => {
                const pending = this.pending.get(id);
                if (pending) {
                    this.pending.delete(id); clearTimeout(timer);
                    reject(error instanceof Error ? error : new Error(String(error)));
                }
            });
        });
    }
    rejectPending(error) {
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer); pending.reject(error);
        }
        this.pending.clear();
    }
    async close() {
        if (this.closed) return;
        this.closed = true;
        this.rejectPending(new Error("HID connection closed"));
        await this.writes;
        await this.device.close();
    }
}
