// SPDX-License-Identifier: MIT
import { connectBridge } from "../../bridge-rpc.mjs";
const peer = await connectBridge({ endpoint: process.argv[2], token: process.argv[3] });
const id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
await peer.request("attach");
await peer.request("snapshot", {
    sessions: [{ id, name: "Bound session", activity: { status: "idle" } }],
    catalogue: [{ id, app_url: `ghapp://sessions/${id}` }],
});
process.send(await peer.request("start"));
