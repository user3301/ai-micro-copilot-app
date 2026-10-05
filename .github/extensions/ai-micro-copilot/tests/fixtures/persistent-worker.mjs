// SPDX-License-Identifier: MIT
import { EventEmitter } from "node:events";
import { BridgeService } from "../../bridge-service.mjs";
const device = new EventEmitter();
let lights = [], closed = false;
const opened = [];
let clock = 0;
device.info = { serialNumber: "test-usb" };
device.request = async (method, params) => {
    if (method === "v.oai.thstatus") lights = params;
};
device.close = async () => { closed = true; };
const service = new BridgeService({
    config: { slots: ["aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", null, null, null, null, null] },
    token: process.argv[3],
    open: async () => device,
    navigate: async url => { opened.push(url); },
    save: async () => {},
    log: () => {},
    now: () => clock,
});
await service.listen(process.argv[2]);
process.on("message", async message => {
    if (message.advance) clock += message.advance;
    await service.controller.enqueue(() => service.controller.tick());
    if (message.input) device.emit("input", { method: "v.oai.hid", params: { k: "AG00", ag: 0, act: 1 } });
    await service.controller.queue;
    process.send({ opened, lights, closed, status: service.status() });
});
process.send({ ready: true });
