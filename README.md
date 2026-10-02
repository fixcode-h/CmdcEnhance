# CmdcEnhance

Command Code（`cmdc`）的状态显示与 Windows shell 编码修复 mod 集合。每个 mod 是一个 TypeScript 文件，由 cmdc 在启动时用 jiti 直接编译加载，**没有构建步骤**。

本仓库不再提供上下文瘦身、工具输出折叠或长输入改写；不会主动压缩或改写模型上下文。CLI 自带的压缩与截断行为不受影响。

## 安装

```powershell
cmd mods add -g E:\Project\CmdcEnhance   # -g = 用户级；去掉则为当前项目级
cmd mods list                            # 确认各 mod 已注册、且没有加载告警
```

装完后在会话里 `/reload` 重载即可生效。本地路径是「原地引用」：改完这个仓库的文件，`/reload` 就是最新代码。

> **Windows 上别直接用 `cmd`**：PATHEXT 里 `.exe` 优先于 `.cmd`，`cmd` 会命中系统的 `cmd.exe`。
> 本机装的别名是 **`cmdc`**（等同 `command-code`），下面示例里的 `cmd` 在 Windows 上请写成 `cmdc`。

## 目录结构

```
mods/      每个 .ts 一个 mod —— package.json 的 commandcode.mods 用 ./mods/*.ts 声明，
           新增 mod 只要往这里丢文件，不用动配置
mods/lib/  被 mod 复用的纯逻辑。`./mods/*.ts` 只匹配一级，所以这里**不会**被当成 mod
           加载（放 mods/ 根下会因为缺默认导出而报加载告警），但 mod 能正常 import。
           它只增加仓库内的相对导入，不新增任何与 cmdc 的耦合——cmdc 升级不碰本仓库。
tests/     单元测试（vitest）：`<名字>.test.ts` 测纯函数，`<名字>.mod.test.ts` 测事件接线
types/     @commandcode/harness 的最小类型声明
```

`@commandcode/harness` **没有发布到 npm**（registry 上是 404），但 mod 只在 `import type` 里用到它，运行时由 cmdc 进程内的 jiti 解析。`types/commandcode-harness.d.ts` 声明了本项目用到的表面，让 `tsc` 能过——用到新的 `ModApi` 成员时往那里补签名。

## mod 列表

### `mods/context-usage.ts`

在输入框下方显示上下文占用进度条：

```
ctx ██████████████████░░ 90% 900k/1M
ctx ██████████████████░░ 90% 900k/1M · 376.0 tok/s
ctx ██████████████████░░ 90% 900k/1M · 376.0 tok/s · ↑3.6M ↓42k · cache 89.00% +12k · ⟳ 3m -30k
```

- **上限从哪来**（按优先级）：`--mod-option contextWindow=<token 数>` → `~/.commandcode/providers.json`（BYOK 的 `contextWindow`）→ `~/.commandcode/cache/models-dev.json` 目录 → 兜底 `200000`。走兜底时数字前面加 `~`，表示这是猜的。
- **模型从哪来**：`model_request_start` / `model_request_end` 事件。启动到第一次请求之间是事件静默期，此时用 `~/.commandcode/config.json` 的 `model` 兜底解析，否则首屏只能显示兜底的 `~200k`。
- **占用口径** = `inputTokens + outputTokens`。CLI 的 `inputTokens` 已是整段 prompt 的总数（`cacheReadTokens` 是它的子集明细，不能相加）。
- **生成速率**（`376.0 tok/s`）= **最近一轮**的 `outputTokens ÷ 纯生成窗口`，对齐 DeepSeek Harness（dsh）的 `throughput` 口径。与左边的 `900k/1M` 一样属「此刻」读数（`session_start` 清空）。**注意它和端到端速率不是一回事**，见下节。
- **会话累计** `↑输入 ↓输出` = 本会话每轮请求的 `inputTokens` / `outputTokens` 之和，`session_start` 清零，只算主上下文、不含子代理。**注意它和左边的 `900k/1M` 不是一回事**：`900k/1M` 是当前上下文长度（快照），`↑3.6M` 是「一共处理了多少 token」——每轮都会把整段 prompt 重发一遍，所以它会随轮次快速增长。首次请求前不显示。
- **缓存段** = 会话累计命中率 `ΣcacheReadTokens / ΣinputTokens`，同样 `session_start` 清零。`+12k` 是会话累计写入缓存的量，只在本会话写过时才出现。**本会话从未有过缓存活动时整段不显示**——不支持 prompt 缓存的 provider 不该常驻一个 `cache 0.00%` 噪音。
- 子代理的请求也走 `model_request_end`，靠 `subagent_start` / `subagent_stop` 的深度计数挡掉，避免进度条跳到子上下文长度。
- 进度条本身颜色随占用率变：<60% 绿，≥60% 黄，≥85% 红。条形宽度按终端列数分档。
- **压缩摘要**：`compaction_done` 后往末尾追加 `· ⟳ <距现在多久> [-<省下的 token>]`，靠一个 unref 的 1s 定时器把时长刷新出来（事件没带 `tokensSaved` 时省略省下的部分），`session_start` 清空。
- **压缩后进度条立即回落**：事件只带 `tokensSaved`、**不带压缩后的真实用量**，所以那一刻直接用 `used - tokensSaved` 把占用扣下去——右侧数字立刻变小，不用等下一轮请求。这是估算值，**下一轮 `model_request_end` 会用真实 `usage` 覆盖它**（所以压缩后数字可能先跳一下再定）。

#### 生成速率：对齐 dsh 口径（`outputTokens ÷ 纯生成窗口`）

口径取自 DeepSeek Harness 的 Trajectory 记录检查器（`packages/client/ui-trajectory/src/client/TrajectoryTable.tsx`）：

```ts
const generationSeconds = (completedTime - firstTokenTime) / 1000
value: (outputTokens / generationSeconds).toFixed(1)   // → `{value} tok/s`
```

本 mod 用同一个公式、同一位小数精度（`376.0 tok/s`）。**区别只在数据源**：dsh 自己把每个 chunk 和它的会话时间戳以差分编码写进 durable 事件（`AssistantStreamAccumulator`），所以它能精确重算历史轮次的时序；而 cmdc 的事件**不带任何耗时**——`model_request_end` 的 payload 只有 `{model, usage, stopReason, effort}`，没有 duration、没有 ttft、没有 timestamp。所以这里的时间仍然只能自测：拿**首个 delta** 与 `model_request_end` 的墙钟差当纯生成窗口。

- **只算纯生成，不含 TTFT。** 同一轮真机数据：总耗时 7438ms、首 token 出现在 5131ms、真实 `outputTokens` 867。

  | 口径 | 算式 | 结果 |
  |---|---|---|
  | 端到端 | 867 ÷ 7438ms | **117 tok/s** |
  | 纯生成（本 mod 与 dsh） | 867 ÷ (7438−5131)ms | **376 tok/s** |

  纯生成口径回答「模型吐字多快」，端到端那个更多是在量 TTFT。dsh 也只这么算。

- **delta 成簇投递，窗口太短就不出数（宁可不显示，也不给噪声数）**。实测一轮 477 个 delta 只落在 **18 个**不同时间戳上，簇内时间差为 0，照簇算会得到 `∞ tok/s`；有的 provider 在**工具轮**更极端，把整轮的 delta 攒到请求结束前一次性投递，纯生成窗口只有 3~6ms。所以只算窗口平均值、绝不算瞬时值，且窗口短于 `MIN_GEN_MS`（200ms）一律判为「量不到」：

  | 轮次性质 | `genWindow`（首个 delta 距请求结束） | 结果 |
  |---|---|---|
  | 纯文本轮（271 delta 跨 936ms） | 936ms | ✅ 出数 |
  | 工具轮 | **3~6ms** | ❌ 不出数 |

  **这是刻意的取舍，代价是工具轮常驻没有速率。** 那种窗口全是计时噪声，用它除只会得到一个由投递时机决定、而非模型速度决定的数；dsh 在 `generationSeconds <= 0`（`时长过短`）时同样留空。整轮一个 delta 都没有（输出全走 tool input 的 JSON）时同理不出数。
  > 历史做法：早期版本在窗口被挡掉时**回退到请求总时长**口径（`end − start`），靠它让工具轮也能出数。但那含 TTFT、数字明显偏小（实测该模型 TTFT 长达 9s，同样的 88 token 会显示 `10 tok/s`），且与 dsh 不同式，已删除。

- **不做流式估算。** dsh 靠真时间戳逐 token 前进，cmdc 拿不到流式 token 数、只能靠猜（初值可能偏 3 倍以上：真机某轮 471 字符 / 520 token）。旧版本用「上一轮字符/token」标定后估算，现按 dsh 的取舍一并删除——本轮只在本轮结算后出数。
- **中断时靠 `run_end` 作废窗口**。请求被 abort / 网络错误时 `model_request_end` 不会发出（它在 CLI 的 `try` 里，异常直接 break），此时把本轮的生成窗口清掉，避免下一轮结算拿一个跨了中断期的陈旧起点当窗口。

#### 为什么缓存用「会话累计」而不是「最近一次」（实测）

真机跑 6 轮、逐轮记录（每轮都让模型调一次工具，制造新内容）：

| 轮次 | 单次命中率 | 累计命中率 |
|---|---|---|
| 1 | 48% | 48% |
| 2 | **99%** | 73% |
| 3 | **99%** | 82% |
| 4 | **99%** | 86% |
| 5 | **99%** | 89% |
| 6 | **99%** | 90% |

- **单次命中率从第 2 轮起就恒为 99~100%**：每轮只是把上一轮的 prompt 再发一遍，本来就几乎全命中。这个数字只在第 1 轮有信息量，之后永远是 `cache 99.00%`——看起来像坏了，其实只是没意义。
- **累计命中率才反映真实健康度**：它把会话早期的冷启动代价摊进来（48% → 90%），掉下来说明缓存被打破过。
- 另一个理由是**尺度一致**：它紧挨着的 `↑输入 ↓输出` 本来就是会话累计，两者同尺度才不会出现「一个是整个对话、一个是这一瞬间」的错位。
- `ΣcacheRead ≤ Σinput` 恒成立（每轮的 read 都是该轮 input 的子集），所以累计率不会溢出 100%，`Math.min(1, …)` 只是保险。

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
2. 在 `tests/` 下建 `xxx.test.ts`，把纯逻辑（格式化、解析、判定）导出后直接测——把逻辑从事件回调里拆出来，才能真正测。接线另建 `xxx.mod.test.ts`，用最小 `ModApi` 桩驱动事件/hook。
3. 复用 `mods/lib/`，别复制粘贴：`flags`（开关判定）、`shell`（命令构造）、`model-catalog`（模型名归一化与上下文上限解析）。放 `mods/lib/` 下的文件不会被当成 mod 加载。
4. `commandcode.mods` 的 glob 会自动带上新文件，无需改 `package.json`。
5. 完整 `ModApi` 契约见 cmdc 自带的 mod-builder 技能：`reference/api.md`、`reference/hooks-and-events.md`、`reference/ui.md`。

### 开关约定

- `--mod-option` 是**全局命名空间**，flag 名一律带 mod 前缀（如 `contextWindow` / `shellEncoding`），否则不同 mod 会撞名。
- 新开关默认开启：`addFlag(name, {type:'boolean', default:true})`，判定统一走 `lib/flags` 的 `flagEnabled`（容错字符串 `false` / `0` / `no` / `off`，未设置时回落 default）。
- **开关必须在运行时判定**：`cmd.getFlag()` 在 factory 阶段可能只返回 default；只有 harness bind 之后（`on` 回调 / hook 里）才返回真实值。所以 `addFlag` 在 factory 里声明，但读取放进 hook 或事件回调。

### 验证

```powershell
npm run typecheck
npm test
cmdc mods list    # 必须列出全部 mod 且**零加载告警**（加载失败会在这里显示原因）
cmdc --mod .\mods\xxx.ts -p "..."   # 单文件试跑，不装也能加载
```

- 只测纯函数和桩接线**不算验完**：一个 import 失败或 factory 抛错的 mod 只会变成一条告警，不会让会话崩，所以不检查 `mods list` 就会静默失效。
- **print 模式（`-p`）有两条边界**：CLI 传入的初始 prompt **不走** `transformInput`（实测：hook 注册了也不会被调用），所以输入拦截类 mod 只能交互式验；Headless 下 `ui.confirm` 恒为 `false`。
- 改完后在会话里 `/reload`（mods 每个进程只加载一次）。
