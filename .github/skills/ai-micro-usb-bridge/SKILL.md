---
name: ai-micro-usb-bridge
description: "Start and verify the Windows AI Micro USB bridge in this repository. Use for 开启usb桥接, 启动USB桥接, 连接键盘, start USB bridge, or ai_micro_control missing/unavailable. Includes recovery when the extension is ready but its tool is not discoverable."
---

# AI Micro USB 桥接启动

用户要求开启桥接时，执行到设备连接并验证，不要只解释步骤。优先调用扩展工具；工具未被发现时，本仓库还有已认证的本机命名管道管理接口，不能仅因工具搜索返回 0 项就宣布无法启动。

## 安全边界

- 只适用于 Windows、Node.js 22+、支持 App 工具的 GitHub Copilot App。
- 保留现有六槽绑定、亮度和设备选择。没有绑定时，列出真实会话让用户选，不要自动绑定当前会话或前六个会话。
- 不刷固件，不自动批准权限，不发送会话消息，不读 App 私有数据库，不拼造 `ghapp://` 链接。
- 不输出或分享 `config.json` / `.bridge-runtime.json` 的原文；后者含本机 RPC 凭据。
- 不直接编辑配置文件，不启动第二个 daemon，不按进程名批量杀进程。
- USB 已在运行且状态正常时，不停止或重启。若配置是蓝牙，通过正常工具先 `stop`，再由用户选定 USB 设备并 `configure`；不要沿用蓝牙序列号。

## 1. 定位仓库、恢复工具

本 Skill 位于 `.github\skills\ai-micro-usb-bridge\SKILL.md`；扩展位于同一仓库的 `.github\extensions\ai-micro-copilot`。使用当前实际 checkout，不要把某台机器的盘符写死。

以下 PowerShell 示例**均在仓库根目录执行**。每次 shell 调用都是新进程；需要切目录或设置环境变量时，必须在该次调用内完成。

1. 搜索工具 `ai_micro_control`，可用就读取其 schema。
2. 未发现工具：调用 `extensions_manage` 的 `list` / `inspect`（`name: "ai-micro-copilot"`），确认路径、ready 状态和日志。
3. 调用 `extensions_reload` 一次，再搜索 `ai_micro_control`。
4. 如果扩展 ready 但工具仍缺失，继续第 3 节的本机 RPC 路径。**ready 不等于工具已暴露，也不等于 daemon 或键盘已连接。**

不要用 `node extension.mjs` 启动扩展，不自行安装 `@github/copilot-sdk`；App 提供 SDK。

## 2. 正常工具路径

1. `ai_micro_control({"operation":"status"})`。若提示 daemon 未运行，按第 3 节启动服务，然后重试。
2. 确认 `transport="usb"`，且至少有一个现有绑定。需要选择设备时用 `devices`，需要选择会话时用 `sessions`。
3. `ai_micro_control({"operation":"start"})`。工具会先从 App 发布新鲜状态及已验证链接，然后启动设备。
4. 再读 `status`，按第 5 节确认结果。

成功就结束，不走备用路径。

## 3. 工具缺失时：检查并启动独立 daemon

### 3.1 用本仓库的 RPC 客户端读取状态

通过 PowerShell 工具执行：

```powershell
@'
import { readFile } from 'node:fs/promises';
import { connectBridge } from './.github/extensions/ai-micro-copilot/bridge-rpc.mjs';
const runtime = JSON.parse(await readFile(new URL('./.github/extensions/ai-micro-copilot/.bridge-runtime.json', import.meta.url), 'utf8'));
const peer = await connectBridge(runtime);
try { console.log(JSON.stringify(await peer.request('status'))); }
finally { peer.close(); }
'@ | node --input-type=module
```

JavaScript 模块路径使用 `/` 是 Node.js 的模块语法；PowerShell 文件路径使用 `\`。

- 返回状态：daemon 已存在，不另起进程。USB 已连接且实时状态正常时直接结束。
- `.bridge-runtime.json` 不存在，或 `connect ENOENT` 指向命名管道：没有可连接的 daemon。旧发现文件存在不证明进程还活着。
- 认证失败、连接被拒绝、超时等其他错误：检查扩展日志和准确的进程信息，不把所有错误都当成“没有服务”。

### 3.2 仅当服务不存在时启动

用 shell 工具执行以下命令，设置 **`mode: "async", detach: true`**：

```powershell
node .\.github\extensions\ai-micro-copilot\daemon.mjs
```

这是长期服务，必须独立于可回收的会话宿主存活。若环境不允许 detached，明确说明限制，让用户在独立 Windows 终端运行同一命令；不要用普通 attached 子进程假装完成持久启动。

保留返回的 shell ID。随后再次执行 3.1，收到有效 `status` 才算服务就绪。命令启动成功不等于键盘连接成功。

如果命令明确报缺少依赖，才在扩展目录运行：

```powershell
Set-Location -LiteralPath '.github\extensions\ai-micro-copilot'
npm ci --registry=https://registry.npmjs.org --no-audit --no-fund
```

安装后重新检查服务是否存在，再决定是否启动。其他错误不要通过重装依赖掩盖。

## 4. 工具仍缺失时：用新鲜 App 快照启动 USB

**为什么需要这一步：** stopped 状态下，扩展的后台循环只读取 daemon 状态，不主动发布快照；直接发送 RPC `start` 可能报 `App status unavailable`。正常工具会先 publish，但工具缺失时需显式完成一次引导。不能用旧缓存冒充实时状态。

### 4.1 获取真实 App 数据

并行调用 App 工具 `get_sessions_status` 和 `list_sessions_and_chats`。

- 大输出会保存为临时文本文件，使用工具返回的**真实路径**，不要只使用预览。
- 若输出直接返回内容，用文件编辑工具将完整 JSON 保存到本会话 artifacts 目录；不要写进仓库。
- 状态文件格式是包含 `sessions` 数组的对象；目录文件可以是数组，也可以以 `Found N item(s):` 开头。
- 只用本次读取的结果，并立即执行下文。失败后隔了较长时间才重试，重新获取两份数据。
- 会话 ID 必须来自上述数据。App project-session ID 与 CLI session ID 可能不同，不能互相猜测替换。

### 4.2 发布最小快照并启动

把以下两处路径替换为 4.1 返回的本机路径，在**同一次 PowerShell 调用**中执行整个代码块。不要复制示例占位路径直接执行。

```powershell
$env:AI_MICRO_STATUS_FILE = '替换为本次状态输出文件的绝对路径'
$env:AI_MICRO_CATALOGUE_FILE = '替换为本次会话目录文件的绝对路径'
@'
import { readFile } from 'node:fs/promises';
import { connectBridge } from './.github/extensions/ai-micro-copilot/bridge-rpc.mjs';
import { parseSnapshot } from './.github/extensions/ai-micro-copilot/core.mjs';
import { sessionUrl } from './.github/extensions/ai-micro-copilot/navigation.mjs';
const runtime = JSON.parse(await readFile(new URL('./.github/extensions/ai-micro-copilot/.bridge-runtime.json', import.meta.url), 'utf8'));
const peer = await connectBridge(runtime);
try {
    const status = await peer.request('status');
    if (status.transport !== 'usb')
        throw new Error('Transport is not USB; stop and select a USB device through the normal configuration flow');
    if (!status.slots.some(slot => slot.sessionId !== null))
        throw new Error('No bindings; ask the user to select sessions first');
    if (status.appConnected && !status.stale) {
        console.log(JSON.stringify(await peer.request('start')));
    } else {
        const needed = new Set(status.slots.map(slot => slot.sessionId).filter(Boolean));
        const snapshot = JSON.parse(await readFile(process.env.AI_MICRO_STATUS_FILE, 'utf8'));
        const text = await readFile(process.env.AI_MICRO_CATALOGUE_FILE, 'utf8');
        const items = JSON.parse(text.replace(/^Found \d+ item\(s\):\s*/, ''));
        if (!Array.isArray(items)) throw new Error('Invalid App catalogue');
        const sessions = parseSnapshot(snapshot).filter(s => needed.has(s.id)).map(s => ({
            id: s.id, name: s.name, project_id: s.project_id, is_running: s.is_running,
            awaiting_user_input: Boolean(s.awaiting_user_input),
            awaiting_plan_approval: Boolean(s.awaiting_plan_approval),
            activity: { status: s.activity?.status },
        }));
        const catalogue = items.filter(s => needed.has(s.id))
            .map(({ id, app_url }) => ({ id, app_url }));
        for (const session of sessions) sessionUrl(catalogue, session.id);
        await peer.request('attach');
        await peer.request('snapshot', { sessions, catalogue });
        console.log(JSON.stringify(await peer.request('start')));
    }
} finally { peer.close(); }
'@ | node --input-type=module
```

此流程只发布绑定槽位的状态和 App 提供的链接，不发送完整目录、聊天正文或提示词，不改配置，也不绕过固件握手。

**单状态源限制：** `attach` 若提示 `Another extension is providing App status`，不要抢占或关闭它。等待一个轮询间隔再读 3.1；若现有源恢复新鲜状态，可直接 RPC `start`；否则检查该扩展日志并明确报告阻塞，不无限重试。

临时 RPC 客户端退出会撤销它自己的状态源，灯可能短暂变为未知。已加载的扩展会在下一轮发现 `running=true` 后接管持续推送。**一次 snapshot 成功不等于持续同步已恢复。**

## 5. 最终验证与回复

等待至少一个配置的 `pollMs` 加 1 秒（默认共 3 秒），重新运行 3.1，确认：

```text
running=true
connected=true
transport=usb
appConnected=true
stale=false
navigationMode=live
error=null
```

同时确认原槽位绑定未变。若扩展尚未接管，检查其日志；可以等待有界时间再次读取，但不能持续人工注入快照假装后台推送正常。设备已连上但状态源未恢复时，明确报告这一部分未完成。

成功回复示例：“USB 桥接已开启，设备已连接，App 实时状态同步正常。现有按键绑定保持不变。”

灯色：idle 绿色常亮、busy 蓝色呼吸、等待输入/审批黄色呼吸、未知/过期紫色缓慢呼吸。当前对话处理中显示蓝色属于正常；长时间未使用 App 不应被直接解释为 busy。`status` 是主机计算结果，不是实体 LED 读回值。

停止只在用户要求或切换设备/连接方式时执行；不要在启动任务结束时清理掉长期 daemon。需要停止且工具不可用时：

```powershell
node .\.github\extensions\ai-micro-copilot\daemon.mjs --stop
```

这会停止硬件，但保留 daemon 管理接口。不要在文档、提交或最终回复中暴露本机凭据文件内容。
