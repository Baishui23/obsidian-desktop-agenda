# Desktop Agenda · 桌面日程

Obsidian 的半透明 Windows 日程窗口。默认放在普通软件窗口下方，查看桌面时查看任务，需要整理时切换到前置编辑。

**0.4.0 · Windows x64 预发布版 · MIT**

[下载安装包](https://github.com/Baishui23/obsidian-desktop-agenda/releases) · [版本记录](CHANGELOG.md)

## 功能

- **置底显示 / 前置编辑**：独立窗口；普通软件可以盖住它，编辑时一键前置。
- 拖动顶部移动，拖动边缘缩放；屏幕按钮将窗口适配到当前屏幕右侧。
- 不透明度 **0%–100%**，文字随整个窗口一起变化；0% 时不拦截鼠标。
- 保存位置、大小、不透明度和显示模式。
- 从 Markdown 原笔记读取 `#task` 任务；今日与遗留 / 全部未完成两个视图。
- 未完成且计划日期或截止日期已过去时标红，不自动修改日期。
- 完成、取消完成、改期写回原笔记；改期历史可展开查看。

## 安装

需要 Windows 10/11 x64、桌面版 Obsidian，以及 Windows .NET Framework 4.x。Obsidian 需保持运行。

1. 在 [Releases](https://github.com/Baishui23/obsidian-desktop-agenda/releases) 下载 `desktop-agenda-0.4.0-windows.zip`。请下载完整安装包，GitHub 自动生成的源码 ZIP 不含编译后的助手。
2. 解压，将其中的 `desktop-agenda` 文件夹放进资料库的 `.obsidian/plugins/`。
3. 在 Obsidian → 设置 → 第三方插件中启用 **Desktop Agenda**。
4. 更新时先关闭插件，再覆盖安装文件并重新启用。保留原 `data.json` 即可保留窗口设置。

这是 GitHub 手动安装版本，尚未提交 Obsidian 社区目录。BRAT 等只下载标准三文件的安装方式尚不支持这个多文件包。

## 日常使用

启动后默认置底，软件窗口可以覆盖它。顶部“桌面”图标在置底和前置编辑之间切换。编辑模式保持普通窗口行为；整理完成后再次点击该图标放回底层。

关闭组件窗口后，可从左侧工具栏图标或命令面板重新打开。禁用插件或退出 Obsidian 会关闭组件和助手。

完全透明时，在命令面板运行 **Desktop Agenda: 恢复可见并编辑窗口（100% 不透明）**，或打开：

```text
obsidian://desktop-agenda?command=restore
```

其他入口：

```text
obsidian://desktop-agenda
obsidian://desktop-agenda?command=bottom
```

## 任务输入模板

在项目笔记或日记中填写真实任务，每条只保留一份：

```markdown
- [ ] 09:00 - 10:00 确认本次交付范围，输出验收清单 #task #首要 ⏳ 2026-10-26
- [ ] 整理设计资料，输出对比记录 #task ⏳ 2026-10-26 📅 2026-10-28
```

| 字段 | 含义 |
| --- | --- |
| `#task` | 必填，声明为可读取任务 |
| `⏳ YYYY-MM-DD` | 计划执行日期，建议填写 |
| `📅 YYYY-MM-DD` | 可选交付截止日期 |
| `#首要` | 首要任务标记 |
| `HH:mm - HH:mm` | 可选的当天时间段 |
| `[ ]` / `[x]` | 未完成 / 已完成 |

缺少显式日期时，尝试使用笔记文件名中的日期；仍无日期则作为未排期任务。日期按**北京时间**判断。模板目录、隐藏目录、代码框及注释中的示例会被跳过。

“今日与遗留”包括今天及之前的未完成计划、已到期和未排期任务。“全部未完成”也包括未来任务。当天完成的任务保留在当天列表，便于撤销。

## 逾期与延期

前一天没有完成的任务继续显示并标红，原日期保留。点击“延期”选择今天、明天或指定日期。

- 默认只修改计划日期 `⏳`。
- 勾选“截止日也改到这一天”才修改或添加 `📅`。
- 保留已过的截止日期时，任务仍会显示逾期提示。
- 原任务下方记录 HTML 注释历史，不复制任务、不自动完成。
- 循环任务仅显示，状态修改交给 Tasks；自定义状态和格式问题会提示。

通过 Obsidian `vault.process` 更新原笔记。原始任务行不唯一、已变化或已移入代码框时拒绝写入，避免误改相似任务。

## Windows 窗口机制

组件是独立的 Electron 窗口，Windows 助手使用 `SetWindowPos` 维护底层顺序，通过前台窗口事件和 500 ms 定时检查处理窗口重新激活。Win+D 导致最小化时，尝试不抢焦点地恢复组件。

这是应用窗口置底方案；没有使用 `SetParent` 把窗口挂进 Explorer。运行时不修改 Obsidian 的 DPI、注册表、系统启动项或 PowerShell 执行策略，也不需要管理员权限。

助手只允许调整本插件创建的 Obsidian 窗口，同时校验句柄、进程和唯一标题。运行时将包内的同一份助手安装到 `%LOCALAPPDATA%/ObsidianDesktopAgenda/native/<版本-校验值>/`，避免资料库的低完整性标签使助手无法调整普通窗口。插件内仍保留分发用的助手文件。卸载后可删除上述专用目录。

窗口渲染关闭 Node.js，启用上下文隔离与沙箱，通过限定 IPC 访问任务。组件不加载网络资源、不上传任务或笔记。

## 开发与打包

无需 npm 依赖。在 Windows PowerShell 7 中执行：

```powershell
./build-native.ps1
./package-release.ps1
```

脚本调用系统 .NET Framework C# 编译器，生成 `desktop-host.exe`；安装 ZIP 和 SHA-256 校验文件位于 `dist/`。打包使用明确的文件列表，不收集个人笔记、运行数据或调试截图。

源码中的窗口状态测试可自行运行：

```text
node --test tests/window-state.test.cjs
```

## 验证范围与限制

本版完成 JavaScript 语法检查、Windows 助手编译和本机 Obsidian 1.14.5 的实际加载。任务写回、跨日、多屏和其他 Windows/Electron 版本的完整验证尚未完成；这是预发布版本。

尚未实现系统提醒、任务时间拖动和背景单独透明。Explorer 重启、虚拟桌面及不同 Windows 的 Win+D 行为仍需实际确认。Obsidian 的 Electron remote 窗口接口变化也可能影响兼容性。

技术依据：[Microsoft SetWindowPos](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwindowpos)、[WinEvent hooks](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwineventhook)、[Windows 完整性级别](https://learn.microsoft.com/en-us/windows/win32/secauthz/mandatory-integrity-control)、[Electron BrowserWindow](https://www.electronjs.org/docs/latest/api/browser-window)。
