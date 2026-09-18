# CmdcEnhance

Command Code（`cmdc`）的 mod 集合。每个 mod 是一个 TypeScript 文件，由 cmdc 在启动时用 jiti 直接编译加载，**没有构建步骤**。

## 安装

```powershell
cmd mods add -g E:\Project\CmdcEnhance   # -g = 用户级；去掉则为当前项目级
cmd mods list                            # 确认各 mod 已注册、且没有加载告警
```

装完后在会话里 `/reload` 重载即可生效。本地路径是「原地引用」：改完这个仓库的文件，`/reload` 就是最新代码。

## 目录结构

```
mods/    每个 .ts 一个 mod —— package.json 的 commandcode.mods 用 ./mods/*.ts 声明，
         新增 mod 只要往这里丢文件，不用动配置
tests/   单元测试（vitest）：`<名字>.test.ts` 测纯函数，`<名字>.mod.test.ts` 测事件接线
types/   @commandcode/harness 的最小类型声明
```

`@commandcode/harness` **没有发布到 npm**（registry 上是 404），但 mod 只在 `import type` 里用到它，运行时由 cmdc 进程内的 jiti 解析。`types/commandcode-harness.d.ts` 声明了本项目用到的表面，让 `tsc` 能过——用到新的 `ModApi` 成员时往那里补签名。

## mod 列表

### `mods/context-usage.ts`

在输入框下方显示上下文占用进度条：

```
ctx ██████████████████░░ 90% 900k/1M
ctx ██████████████████░░ 90% 900k/1M · ↑3.6M ↓42k
ctx ██████████████████░░ 90% 900k/1M · ↑3.6M ↓42k · cache 48% +12k · ⟳ 3m -30k
```

- **上限从哪来**（按优先级）：`--mod-option contextWindow=<token 数>` → `~/.commandcode/providers.json`（BYOK 的 `contextWindow`）→ `~/.commandcode/cache/models-dev.json` 目录 → 兜底 `200000`。走兜底时数字前面加 `~`，表示这是猜的。
- **模型从哪来**：`model_request_start` / `model_request_end` 事件。启动到第一次请求之间是事件静默期，此时用 `~/.commandcode/config.json` 的 `model` 兜底解析，否则首屏只能显示兜底的 `~200k`。
- **占用口径** = `inputTokens + outputTokens`。CLI 的 `inputTokens` 已是整段 prompt 的总数（`cacheReadTokens` 是它的子集明细，不能相加）。
- **会话累计** `↑输入 ↓输出` = 本会话每轮请求的 `inputTokens` / `outputTokens` 之和，`session_start` 清零，只算主上下文、不含子代理。**注意它和左边的 `900k/1M` 不是一回事**：`900k/1M` 是当前上下文长度（快照），`↑3.6M` 是「一共处理了多少 token」——每轮都会把整段 prompt 重发一遍，所以它会随轮次快速增长。首次请求前不显示。
- **缓存段** = `cacheReadTokens / inputTokens`，即本次输入里走缓存读的比例。高命中率意味着 prompt 前缀缓存没被打破（省时省钱）；掉下来通常说明上下文变了。`+12k` 是本次写入缓存的量（`cacheWriteTokens`），只在 >0 时出现。**两项都为 0 时整段不显示**——不支持 prompt 缓存的 provider 不该常驻一个 `cache 0%` 噪音。
- 子代理的请求也走 `model_request_end`，靠 `subagent_start` / `subagent_stop` 的深度计数挡掉，避免进度条跳到子上下文长度。
- 进度条本身颜色随占用率变：<60% 绿，≥60% 黄，≥85% 红。条形宽度按终端列数分档。
- **压缩摘要**：`compaction_done` 后往末尾追加 `· ⟳ <距现在多久> [-<省下的 token>]`，靠一个 unref 的 1s 定时器把时长刷新出来（事件没带 `tokensSaved` 时省略省下的部分），`session_start` 清空。

给目录里查不到的模型手动指定窗口：

```powershell
cmd --mod-option contextWindow=1000000
```

### `mods/shell-encoding.ts`

修 Windows 上 SHELL 工具（`shell_command`）的**中文乱码**：

- **根因**：CLI 的 `runtime.shell.run` 把子进程输出读成 `String(chunk)`（对 Buffer 就是硬编码 UTF-8 解码），而中文系统上 cmd.exe 输出 GBK 字节 → 非法 UTF-8 → 变成 `�` 替换字符，**原始字节不可逆丢失**，所以事后在 `afterToolCall` 里转码救不回来。cmd.exe 的消息编码又在进程启动时按控制台代码页定死，之后再 `chcp` 也改不动本进程；CLI 还带 `windowsHide` spawn、每条命令一个独立控制台，"预热"代码页同样无效。
- **做法**：`beforeToolCall` 把真正执行的命令改写成 `chcp 65001>nul & cmd /d /s /c "<原命令>"` —— 外层先切代码页，内层 cmd.exe 启动时就拿到 UTF-8。`/d /s` 让首尾引号剥离规则确定（外层 CLI 还会再包一层引号），用 `&` 分隔保证退出码仍是原命令的。UI 里显示的仍是原命令。
- **注意**：该工具在 Windows 上**恒用 cmd.exe**（Node `shell:true` → `ComSpec`），与 `PSModulePath` 无关 —— 别按它去猜 PowerShell 分支，那会把 PowerShell 语法喂给 cmd.exe。
- **代价**：内层 cmd.exe 在 65001 下会切换到英文消息资源，**cmd 自身的中文报错变成英文**；命令自己 `echo` 的中文、外部程序在 65001 下的输出都是 UTF-8，显示正常。
- 关掉（回到 CLI 原始行为）：`cmd --mod-option shellEncoding=false`。

## 开发

```powershell
npm install
npm test          # vitest run
npm run typecheck # tsc --noEmit
```

改完 mod 后在 cmdc 会话里 `/reload`（mods 每个进程只加载一次，`/reload` 会重启并重新导入全部 mod）。

不加参数单文件试跑：

```powershell
cmd --mod .\mods\context-usage.ts
```

## 新增一个 mod

1. 在 `mods/` 下建 `xxx.ts`，默认导出 `(cmd: ModApi) => void`。
2. 在 `tests/` 下建 `xxx.test.ts`，把纯逻辑（格式化、解析、判定）导出后直接测——把逻辑从事件回调里拆出来，才能真正测。
3. `commandcode.mods` 的 glob 会自动带上新文件，无需改 `package.json`。
4. 完整 `ModApi` 契约见 cmdc 自带的 mod-builder 技能：`reference/api.md`、`reference/hooks-and-events.md`、`reference/ui.md`。
