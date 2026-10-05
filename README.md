# AI Micro for GitHub Copilot App

Use your AI Micro / Codex Micro desktop keypad to switch between GitHub Copilot App sessions and show their status on six Agent-key LEDs.

**Windows · USB or Bluetooth · No firmware flashing for the verified stock firmware**

This is an unofficial, community-maintained host extension, not firmware or an official GitHub or AI Micro product. It requires a compatible **GitHub Copilot App** with CLI extension support and the experimental App tool bridge. It does not work with just the VS Code Copilot extension or a standalone CLI without App tools.

[中文安装与配置指南](.github/extensions/ai-micro-copilot/README.md)

## Features

- Bind each of the six Agent keys to a specific App project session, independent of sidebar ordering.
- Show App-reported busy, waiting, idle, unknown and offline states on the keys.
- Switch sessions directly using Agent keys, the rotary encoder and the joystick.
- Keep cached session navigation working after the App recycles the hosting CLI. A separate HID daemon survives; unavailable App status is shown as unknown, not as the last live color.
- Change bindings through an agent conversation: save configuration and apply it immediately, without restarting the bridge.
- Connect over USB or Windows Bluetooth HID, and retry the same device after disconnection.
- Turn off background and function-key lighting after five minutes without hardware input, while keeping Agent status LEDs active; the next operation wakes the background and still performs its action.
- Keep configuration local. No additional GitHub token, App database access, global key injection, automatic approvals or prompt sending.

The keys represent **project sessions**, not temporary subagents within a session. Green means the App reports an idle session, not that its task succeeded.

## Requirements

- Windows with Node.js 22 or newer and npm.
- GitHub Copilot App exposing CLI extensions, `session.rpc.tools.execute`, session status/listing tools, and its registered `ghapp://` navigation handler.
- An AI Micro keyboard with a supported firmware identity:
  - Verified stock **Board3**, version **`0.1.37-ai-micro-idf-nimble`**, protocol `codex-micro-hid`.
  - AI Micro Basic's `codex` example, reporting `firmwareFamily=basic` and `example=codex`.
- For USB: a data-capable USB-C cable.
- For Bluetooth: pair and connect the keyboard in Windows, and disconnect USB data so the firmware uses BLE.

Other firmware versions are rejected until verified. This repository does not include firmware, flashing tools, or a firmware update procedure. See the [manufacturer's documentation](https://micro.diyshare.cn/) for hardware information.

## Quick start

1. Clone this repository and open its **root folder** in a local GitHub Copilot App session. The host discovers `.github\extensions\ai-micro-copilot\extension.mjs`.
2. Install dependencies in the **same workspace that will host the bridge**. If the App creates a separate worktree, run these commands there rather than only in the original clone:

   ```powershell
   Set-Location -LiteralPath '.github\extensions\ai-micro-copilot'
   npm ci --registry=https://registry.npmjs.org --no-audit --no-fund
   ```

3. From an **independent Windows terminal**, enter the same extension directory and run `npm run daemon`. Leave it running. This starts the hardware service but does not connect the keyboard until you request `start`. Do not launch it as an ordinary child of the recyclable Copilot CLI; an agent-assisted launch must use an explicitly detached process and verify readiness.
4. Ask the agent to reload extensions and confirm that `ai-micro-copilot` is ready. Do not install `@github/copilot-sdk` yourself or launch `extension.mjs` with `node`; the App provides the SDK and session connection.
5. Ask the agent to list AI Micro devices and available sessions. Select USB or Bluetooth, the corresponding device serial number, and at least one session binding. The public configuration example has **no personal IDs** and defaults to USB.
6. Ask the agent to start the AI Micro bridge and confirm its status is `running=true`, `connected=true`, `appConnected=true`, `stale=false`, with no error.

Example conversation:

> List my AI Micro devices and the Copilot App sessions I can bind.
>
> Use Bluetooth and the device I selected. Bind this session to Agent 1.
>
> Start the AI Micro bridge.
>
> Bind my "Frontend work" session to Agent 2.
>
> Clear the binding on Agent 2.

You can use the same requests in Chinese, for example: **“把这个会话绑定到 Agent 1”** and **“启动 AI Micro 蓝牙桥接”**. The agent must resolve real session IDs and your device selection instead of guessing them.

### Installing in another project

Copy this repository's `.github\extensions\ai-micro-copilot` folder into the same location in the project that will host the bridge, install dependencies there, and reload extensions in that project's session. Use the repository files only: do not copy another person's `config.json` or `node_modules`, and do not overwrite an existing local configuration.

Only one local session needs to host the bridge; the six target sessions do not each need an installation. The management tool is available only in sessions loading this extension. Multiple copies cannot run the hardware bridge simultaneously under the same Windows user.

## Configuration and restarts

The extension creates `.github\extensions\ai-micro-copilot\config.json` when you configure it. This ignored file contains your session bindings, device selection, brightness and key mappings. `config.example.json` documents the defaults; copying it is optional.

Use the `ai_micro_control` tool through the agent to change bindings. Its `bind` operation saves the file atomically and updates the running bridge. **There is no file watcher**: manual JSON edits require stopping the bridge and restarting the daemon.

When the App recycles the hosting CLI, only its status feed disconnects. The independent daemon keeps the HID connection, device reconnect loop and verified navigation links. Bound keys become purple/unknown on feed loss (or after the freshness deadline if the feed stalls). Agent keys, previous/next and focus keep working from the last verified catalogue. Waiting-session selection, creation and configuration require fresh App data and fail explicitly while offline. Cached targets can have been deleted; the daemon never substitutes another session or invents a URL.

When the hosting extension loads again, it reconnects and resumes status updates automatically, without reopening HID or requiring `start`. Pressing a key requests navigation, not a model turn, so navigating to a session does not guarantee the App reloads its extension immediately. Status remains unknown until a fresh feed is available.

`stop` explicitly closes HID, turns off LEDs and stops navigation; feed reconnection does **not** undo it. The daemon remains available for management. With no App connection, run `node daemon.mjs --stop` from the same directory to stop the hardware. Ctrl+C in the independent daemon terminal exits the service. After a computer restart or daemon exit, launch it again and explicitly start the bridge; no Windows autostart is installed. An App restart alone need not terminate the daemon.

The ignored `.bridge-runtime.json` contains a per-launch local IPC credential, never a GitHub token. Do not share it. One authenticated Windows named-pipe service owns the keyboard per Windows user; it accepts one status producer at a time. This is a local same-user trust boundary, not a sandbox against programs already running as you.

`backgroundIdleMs` controls background-light inactivity: it defaults to `300000` (five minutes), accepts integer milliseconds up to `86400000`, and can be set to `0` to disable automatic background shutoff. Existing configurations without this field use the five-minute default. Agent LEDs keep updating; App activity and binding changes do not reset the hardware-input timer. Shutoff is applied on the first polling cycle after the threshold, not an exact hardware timer. Reconnection preserves inactivity, while restarting the bridge starts a fresh interval. Controls mapped to `none` can still wake the lights without triggering an App action. This saves LED power, not Bluetooth power, and does not enable firmware deep sleep.

The default ACT09 action creates an empty App session, potentially including a worktree. It does not start an agent or send a prompt. You can disable it with `config.keys.ACT09 = "none"` through `configure`. See the [full key map, LED meanings and tool reference](.github/extensions/ai-micro-copilot/README.md).

## Repository layout

```text
ai-micro-copilot-app\
  README.md
  LICENSE
  THIRD_PARTY_NOTICES.md
  .gitignore
  .github\
    workflows\
      test.yml
    extensions\
      ai-micro-copilot\
        extension.mjs
        daemon.mjs
        bridge-client.mjs
        bridge-service.mjs
        bridge-rpc.mjs
        controller.mjs
        core.mjs
        hid.mjs
        navigation.mjs
        config.example.json
        package.json
        package-lock.json
        README.md
        .gitignore
        tests\
          bridge.test.mjs
```

The repository name is `ai-micro-copilot-app`; the installed extension name remains `ai-micro-copilot`, and its tool is `ai_micro_control`.

## Development

From `.github\extensions\ai-micro-copilot`:

```powershell
npm ci --registry=https://registry.npmjs.org --no-audit --no-fund
npm run check
npm test
```

Tests use mock HID and App adapters; they do not connect to a physical keyboard or require a running App. GitHub Actions runs syntax checks and tests on Windows with Node.js 22. Hardware acceptance is separate.

Lifecycle regressions run real separate Node processes and Windows named pipes, terminate the App-feed producer, and check continued navigation, unknown LEDs, feed restoration and explicit stop. USB hardware testing on 2026-10-02 also confirmed navigation after terminating the actual session extension and automatic status recovery after reloading it, without restarting the daemon or issuing another `start`.

The entrypoint registers tools and feeds compact App state through `bridge-client.mjs`. `daemon.mjs` / `bridge-service.mjs` own configuration, the singleton pipe and HID lifetime; `bridge-rpc.mjs` provides authenticated, bounded request/reply transport. `controller.mjs` coordinates device state and actions; `core.mjs` handles configuration, framing and state mapping; `hid.mjs` manages USB/Bluetooth HID; `navigation.mjs` validates App-supplied links.

After changing daemon/controller code, explicitly stop hardware, restart the independent daemon, reload the extension and start hardware again. Reloading only the session extension does not update an already-running daemon. Preserve firmware identity checks, explicit device selection and the prohibition on automatic approvals or prompt sending.

## Compatibility and limitations

Stock-firmware hardware testing has confirmed Bluetooth session navigation, LEDs, rotary input, live rebinding and one keyboard power-off/on recovery. USB navigation has also been confirmed. See the [detailed validation record](.github/extensions/ai-micro-copilot/README.md#验证边界与排查).

- No Windows/App autostart, automatic USB/Bluetooth switching, or support claimed for macOS/Linux.
- Sleep/wake, Bluetooth-adapter toggling, long-running stability, all ACT keys and six simultaneously active sessions still need hardware validation.
- App tool and SDK compatibility is experimental and may change.
- Loss of the App feed changes LEDs to unknown while the daemon is alive. A crash/forced termination of the daemon itself or computer sleep can still leave the last LED colors on the keyboard; LEDs are not a firmware-level heartbeat.
- Error colors depend on what the App exposes; ordinary tool failures are not automatically classified as failed sessions.

When reporting an issue, include Windows, Node, App and firmware versions, transport, reproduction steps and a **redacted** error. Do not upload `config.json`, `.bridge-runtime.json`, session IDs, device serial numbers, private session titles or full session logs.

## License and acknowledgements

The extension is MIT licensed; see [LICENSE](LICENSE). The AI Micro hardware and protocol originate from [虾米实验室](https://micro.diyshare.cn/). Upstream attribution is retained in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Firmware source and binaries are not distributed here.
