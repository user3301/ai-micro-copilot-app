# AI Micro × GitHub Copilot App（Windows USB / 蓝牙）

这是 `ai-micro-copilot-app` 独立仓库中的扩展，扩展名称仍为 `ai-micro-copilot`。本仓库只维护主机端桥接，不包含固件源码或二进制；这是非官方社区项目。[返回仓库首页](../../../README.md)。

本扩展把 AI Micro 的六个 Agent 键固定绑定到 Copilot App 的六个**项目会话**，并将 App 报告的状态发送到对应灯位。绑定不随侧栏排序改变，不把同一会话里的临时子 Agent 当成独立槽位。

```text
AI Micro（兼容的出厂固件或 Basic codex 示例）
    USB 或 Windows 蓝牙 Vendor HID Report 6
    本地 ai-micro-copilot 扩展
    Copilot SDK session.rpc.tools.execute
    get_sessions_status / list_sessions_and_chats / create_session
    App 返回的 ghapp:// 会话链接 → Windows 注册的 App 处理器
```

不需要 GitHub Token，不解析聊天正文，不读写 App 的私有数据库，不启动网络 HTTP 服务。不模拟全局快捷键，不自动批准权限，不发送 Agent 提示词，不烧录固件。

## 前提与安装

- Windows、Node.js 22 或更新版本。
- 支持 CLI 扩展以及 `session.rpc.tools.execute` 的 GitHub Copilot App。该 SDK 接口为实验性接口，不是 GitHub REST API；普通 VS Code Copilot 扩展不能替代此宿主。
- 支持两种固件身份：AI Micro Basic 的 **codex 示例**（`firmwareFamily=basic`、`example=codex`），或实机确认的 Board3 出厂固件 **`0.1.37-ai-micro-idf-nimble`**（`protocol=codex-micro-hid`）。握手检查 `device.status`，再验证灯光方法；其他版本明确拒绝，不仅凭设备名称放行。固件需由厂商另行提供，本仓库不分发固件。
- USB 模式使用 USB-C **数据线**，Windows HID 路径为 `HID#VID_303A&PID_8360&MI_...`。
- 蓝牙模式先在 Windows 配对并连接键盘，断开 USB 数据连接。BLE HID 路径为 `HID#{00001812-...}_Dev_VID&02303a_PID&8360_...`。两种模式均只打开 Usage Page `0xFF00`、Usage `1` 的厂商接口，不打开普通键盘接口。Windows/node-hid 将蓝牙报告也呈现为包含 Report ID 的 64 字节 Report 6；不需要单独的 GATT 库。

在 Copilot App 中打开本仓库的**根目录**作为本地项目，使当前会话能发现 `.github\extensions\ai-micro-copilot\extension.mjs`。不要只打开扩展子目录，也不需要原固件目录。

PowerShell 中进入承载桥接的会话工作区根目录，然后执行以下命令。如果 App 为会话创建了 worktree，依赖也应安装在该 worktree 中，而非只安装在最初的克隆目录：

```powershell
Set-Location -LiteralPath '.github\extensions\ai-micro-copilot'
npm ci --registry=https://registry.npmjs.org --no-audit --no-fund
npm run check
npm test
```

让 Copilot 重新加载扩展，再检查 `ai-micro-copilot` 为 ready。SDK 由 App 提供，不要自行安装另一个 `@github/copilot-sdk`。

本次实机使用兼容的出厂固件，**无需刷机**。硬件与固件信息请参阅[厂商文档](https://micro.diyshare.cn/)。桥接不会执行烧录、修改分区或改变原有 USB / BLE 协议；不要为安装本扩展而擦除或替换固件。

## 配置和启动

扩展提供 `ai_micro_control` 工具，支持：

| operation | 行为 |
|---|---|
| `sessions` | 从 App 实时列出可绑定的项目会话及稳定 ID |
| `devices` | 枚举 USB / 蓝牙 Vendor HID，返回 transport、serialNumber；枚举到配对记录不代表握手成功 |
| `configure` | 验证并保存 `config` 更新；不启动桥接 |
| `bind` | 使用 `slot`（1–6）和 `sessionId`（ID 或 null）仅修改一个键，保存并即时应用，不影响其他键 |
| `start` | 获取本机单实例锁，握手设备，开始状态轮询和按键监听 |
| `status` | 连接方式、设备序列号、固件版本、六槽绑定、最近错误，以及 `backgroundIdle` / `backgroundIdleMs`；这是缓存，不会主动刷新 App |
| `stop` | 停止监听，尽力熄灯，关闭 HID，释放锁 |

先让 Copilot 列出会话，由你指定按键 1–6 的顺序；不能擅自取列表前六项。示例：

```json
{
  "operation": "configure",
  "config": {
    "slots": ["从 sessions 返回值中选择的真实 ID", null, null, null, null, null],
    "brightness": 0.25
  }
}
```

`slots` 恰好六项，每项为稳定 ID 或 `null`，不接受重复 ID。配置保存在扩展旁的 `config.json`，默认忽略版本控制；示例模板为 `config.example.json`。不要把包含个人会话 ID 或设备标识的配置公开发布。默认 `transport` 为 `usb`，兼容旧配置；同一连接方式出现多个设备时必须用 `serialNumber` 选择，不能猜。

切换蓝牙时先 `stop`，然后 `devices` 查出蓝牙接口的序列号，再调用：

```json
{
  "operation": "configure",
  "config": {
    "transport": "bluetooth",
    "serialNumber": "devices 返回的蓝牙接口序列号"
  }
}
```

随后 `start`。只更新连接设置会保留全部绑定。同一设备的 USB 与蓝牙序列号可能不同，不能互用。更改连接方式或序列号前必须停桥接，不会自动切换 USB/蓝牙，也不会在重连时改选其他设备。握手还检查固件实际报告的活动连接方式。

配置后调用 `start`。绑定至少一个会话才能启动。**启动状态不持久化**，重新加载扩展、重启 App 或结束承载扩展的会话后，需要再次启动；绑定和亮度会保留。只需一个本地会话承载桥接，不需要六个会话都安装扩展。Windows 命名管道锁防止本用户的多个扩展实例争用设备。

### 通过对话动态绑定

在能调用此扩展工具的会话中说“把某某会话绑定到 Agent 2”。Agent 先从 `sessions` 解析真实 ID，再调用：

```json
{
  "operation": "bind",
  "slot": 2,
  "sessionId": "sessions 返回的真实 ID"
}
```

取消绑定使用 `"sessionId": null`。工具串行校验、原子保存 `config.json`，然后同步内存配置和灯光；桥接运行中不需要重启，之后按键使用新绑定。重复 ID、无效槽位、不存在的会话及写盘失败会明确报错，不覆盖当前绑定。已保存但灯光同步失败时会明确提示“配置已保存”，并在恢复连接后重新同步。

**没有文件监听器**：Agent 应调用工具，而不是直接改 JSON 文件。手工编辑磁盘文件需先停止并重新加载扩展，再启动才生效。工具只出现在加载了此扩展的会话中；不保证所有项目会话都直接具备它。

## 按键与灯光

| 面板 ID | 默认行为 |
|---|---|
| AG00–AG05 | 切换到固定槽位的会话；空槽报错，不新建任务 |
| ACT06 / ACT07 | 上一 / 下一已绑定且仍存在的会话 |
| ACT08 | 在已绑定会话中循环跳到等待输入或计划审批的会话 |
| ACT09 | 在最后一次硬件选中会话的项目中新建空会话；可能创建 worktree，不启动 Agent、不自动绑定、不自动切换 |
| ACT10 | 在承载桥接的会话时间线输出六槽状态 |
| ACT11 | 回到最后一次用硬件选中的会话 |
| ACT12 | 亮度循环：25% → 50% → 关闭 → 10% → 25% |
| 旋钮 ENC_CW / ENC_CC | 下一 / 上一；沿用原固件的方向命名，可在配置中互换 |
| 旋钮按下 | 回到硬件选中的会话 |
| 摇杆左 / 右 | 上一 / 下一 |
| 摇杆上 / 下 | 等待处理 / 查看状态 |

触摸、电源键保持原固件行为，不映射为 App 操作；长触摸清理 BLE 配对、电源硬件长按关机均未改变。按键只处理按下，不在释放时重复执行；旋钮方向同时支持 Basic 的 `act=1` 和实测出厂固件的 `act=2`，其他键的 `act=2` 不执行。鼠标在 App 中切换会话**不会**更新“硬件选中”槽位；更换或清除已选中槽位的绑定会重置该选择，需重新按键选中。

会话切换不使用 `navigate_to`，因为实测该工具只显示需要点击 **Open** 的卡片。扩展从 `list_sessions_and_chats` 取得所选 ID 的真实 `app_url`，校验为同一 ID 的 `ghapp://sessions/...` 链接，再交给 Windows 的 App 注册入口，因此物理按键可直接切换。不会拼造 URL，不接受网页地址或命令参数；传给 PowerShell 的脚本是固定文本，URL 通过环境变量作为数据传入。

可以通过 `config.keys` 把上述功能键映射到表中动作，或 `none` 禁用。不接受任意命令、权限批准、自动发消息等动作。例如禁用创建 worktree：`{"operation":"configure","config":{"keys":{"ACT09":"none"}}}`。

### 空闲背景灯节能

默认连续 **5 分钟没有有效键盘操作**后，关闭环境背景灯和普通功能键灯，**六个 Agent 状态灯保持原亮度并继续更新**。这里的空闲指键盘没有被操作，不是会话的 idle 状态；Agent 忙碌、等待输入、状态轮询或修改绑定都不会重置计时。

按 Agent 键、功能键、旋钮按压/旋转或摇杆有效方向会恢复当前配置的背景亮度，同时正常执行该次操作，不吞掉第一次按键。映射为 `none` 的控件仍可唤醒，但不执行 App 操作；释放事件、摇杆回中、未知输入及旧连接的事件不会唤醒。触摸和电源键仍由原固件处理。

`backgroundIdleMs` 默认 `300000`，接受 `0`–`86400000` 的整数毫秒值，`0` 表示禁用自动熄背景灯。旧配置未包含此字段时也采用 5 分钟默认值。可通过工具即时修改并保存，例如：

```json
{"operation":"configure","config":{"backgroundIdleMs":300000}}
```

熄灯在达到阈值后的下一次轮询中应用（默认轮询间隔 2 秒，排队或慢请求可能延迟），不会早于阈值。使用单调时钟计时；桥接重新启动时重新计时，设备断线重连不会重置计时，也不会先亮背景灯再熄灭。熄灯不改写已保存的 `brightness`；用户把亮度设为零时，唤醒也不会强行打开灯。

`status.backgroundIdle=true` 表示运行中的桥接最近已成功下发空闲背景灯设置，不是硬件光线传感器读数；连接故障时还应检查 `connected` 和 `error`。这只是 LED 节能，蓝牙与状态轮询仍运行，不是固件深度休眠。

| 颜色 / 效果 | 含义 |
|---|---|
| 蓝色呼吸 | App 报告 busy |
| 黄色呼吸 | App 报告等待用户输入或计划审批，优先于 busy |
| 绿色常亮 | App 明确报告 idle，表示当前未处理请求；不表示任务已交付成功 |
| 暗灰常亮 | 该 ID 已不在列表，或未运行且没有明确的 busy/idle 状态 |
| 紫色缓慢呼吸 | App 状态未知，或读取状态失败 |
| 红色呼吸 | App 明确返回 failed/error 活动状态；目前接口不保证暴露这种状态，不从普通工具失败推断 |
| 熄灭 | 未绑定，或亮度为零 |

默认每 2 秒刷新，可设置 1–30 秒。失败有时间线错误，不把未知状态画成成功；USB / 蓝牙断连后重试，重连重新握手并全量同步灯位。输入与轮询串行执行；最多排队 16 项，超限明确报错，旧连接排队的操作不会在新连接上重放。App 的正常权限机制仍有效。

App 的 `is_running=false` 不能单独代表会话离线：正常回答结束后也可能为 false，同时 `activity.status=idle`。灯光优先使用等待输入/审批、显式错误及 busy/idle，再以运行标记辅助判断离线。否则会把完成后的绿色错误覆盖成暗灰色。已保存但未工作的会话若被 App 报告为 idle，也显示绿色，不推断其历史任务已成功完成。

## 验证边界与排查

软件测试覆盖分帧、UTF-8、4096 字节上限、异常数据、固定六槽、灯色优先级、两种连接方式的选择与握手、旋钮 `act=2`、动态单键绑定与并发更新、保存失败、设备身份固定重连、丢弃旧连接操作和退出。空闲灯光测试覆盖 5 分钟阈值前后、Agent 灯继续更新、输入唤醒并执行一次、禁用控件唤醒、可配置/关闭计时、重连不误亮及错误恢复。Mock HID 测试不能代替实机验收。

本次实机联调：最初只发现 BLE，更换数据线并直连电脑后发现 USB；已读取出厂固件版本、通过握手并成功下发灯光。用户确认等待回答时 Agent 1 灯光符合预期，以及从其他会话按 Agent 1 可直接切回，无需点击 Open。桥接运行时状态为 connected、非 stale、无错误。未刷写设备。

现有出厂固件蓝牙探针实测：35 次状态/版本/六槽灯光请求全部成功，延迟中位数约 75 ms、最大 587 ms；三次关闭/重开 HID 句柄成功。用户确认六键测试颜色，已捕获六个 Agent 键、旋钮按压、32 个旋转事件及摇杆四方向。

2026-09-29 蓝牙扩展实机验收（出厂固件未改动）：

- Agent 1–3 及旋钮能直接切换到对应 Copilot App 会话，用户确认正常。
- 保持扩展运行，把一个会话临时从 Agent 2 移到 Agent 4；用户确认 Agent 4 打开正确会话、灯光即时更新，然后恢复原绑定。配置保存到 `config.json`，无需重启或刷机。
- 用户将键盘关机后重新开机，扩展日志记录断连、枚举失败重试、自动恢复；无需重新配对或手工重启桥接。重连后用户再次确认会话切换和灯光正常。这是一次真实开关机恢复，不是仅重开 HID 句柄。

尚未验收：电脑睡眠/唤醒、电脑蓝牙关闭再开启、反复开关机压力测试、全部 ACT 功能键、六个真实会话同时运行和长期稳定性。单次恢复不能替代这些测试。

若 `devices` 返回空列表：USB 模式检查数据线和 USB 枚举；蓝牙模式检查键盘开机、Windows 配对连接及 USB 数据线是否已断开。仅有 `HID#{00001812-...}_Dev_...` 时应选择 `bluetooth`，不能选择 `usb`。配对记录存在但设备未在线仍可能枚举到，最终以握手及持续状态请求成功为准。若枚举为 ESP32 ROM 串口，设备处于下载模式，不是应用 HID。

若握手报固件不支持：先用厂商工具确认版本，核实协议后再扩展兼容范围。不要为了消除错误直接跳过身份检查，也不要仅为安装本扩展而尝试刷机。

若按键无效：先 `status` 确认 running、connected，再检查槽位；关闭可能同时占用设备的 Codex 主机程序。扩展问题用 `extensions_manage inspect` 查看错误日志。

会话列表较大时，App 可能返回 `Output too large to read at once ... Saved to: ...`，而不是直接返回 JSON。扩展会读取该次工具输出的完整临时文件，再解析列表或状态；不会使用截断的预览，也不会猜测会话链接。仅接受本机临时目录下符合 App 命名规则的输出文件，大小上限为 16 MiB；读取过程中同样强制限长，最多读取 16 MiB 加 1 字节以检测超限，即使文件在大小检查后增长也会拒绝。文件丢失或格式不支持时明确报错。旧版本出现 `Unexpected token 'O'` 时，应更新扩展并重新加载、启动桥接；删除会话或重新配对蓝牙不是解决办法。

**原基础固件没有主机心跳超时熄灯功能，出厂固件的异常退出行为尚未验证**：正常 `stop` 会发送熄灯指令，但 App 崩溃、强杀进程或电脑睡眠可能使键盘保留最后一次灯色。此时灯光不能作为实时状态依据。重启桥接后全量同步；长期可靠离线指示需要后续验证或增加固件 watchdog。本版不声称解决这一限制。
