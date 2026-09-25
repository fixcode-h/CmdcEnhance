# CmdcEnhance

Command Code（`cmdc`）的 mod 集合。每个 mod 是一个 TypeScript 文件，由 cmdc 在启动时用 jiti 直接编译加载，**没有构建步骤**。

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

### `mods/output-fold.ts`

折叠超长的工具输出，只把头尾留给模型，全文落盘：

```
[cmdc-enhance:folded] 已省略 3821 行（91340 字符）
完整输出已保存到 E:\...\.commandcode\temp\<sessionId>\tool-output\call_xxx.txt
需要中间部分时用 read_file 读取该文件（可配合 offset / limit），不要重跑原命令。
```

- **动机**：工具结果进上下文后**每一轮都会被重发**，CLI 默认全量给模型。`npm test` 吐几千行、读大文件，此后每轮都在为它付钱。
- **机制**：`afterToolCall` 返回 `{content}` **整体替换**模型看到的结果。改的是本轮刚产生的块——它本来就是未命中 prompt 缓存的新内容，所以替换**不损失缓存**（这也是它优于 `transformContext` 的地方）；且不写回 `state.messages`，磁盘 transcript 仍是完整版。
- **结果形状**（实测确认，文档没写）：`result` 是 content block 数组 `[{type:'text', text}]`，不是 `{content:[...]}`。只折**单个最大的 text 块**，图片等其它块原样保留；形状认不出来一律放行。
- **回溯指针是硬要求**：被省掉的中间内容是真没了，所以标记里必须给**完整绝对路径**（`read_file` 要完整路径；相对路径和 `~` 都不行）。没有它，模型只会瞎猜或重跑原命令——那比不折更贵。
- **fail-open**：落盘失败就不折叠。宁可不省，也不能把没备份的内容丢掉。
- 触发按**字符数**（token 估算对中文偏差太大），默认 20000；保留头 80 行 + 尾 40 行，**尾部从后面截**（结尾往往是报错和汇总）。
- 排除 `edit_file` / `write_file` / `todo_write`：它们是模型必须精确读到的确认信息，且通常很短。
- 幂等：结果里已含 `[cmdc-enhance:folded]` 就跳过。

> **副作用（须知）**：`afterToolCall` 的 `content` 同时决定**模型看到的**和 **`tool_completed` 事件携带的**内容，
> 所以你在界面上看到的工具输出也会是折叠版，不是原始全文。想看全文就去读落盘文件。
> 这是 API 的硬约束——没有「只折给模型、不折给用户」的通道。

```powershell
cmd --mod-option outputFold=false        # 关掉
cmd --mod-option outputFoldLimit=50000   # 调阈值
cmd --mod-option outputFoldSkip=         # 空串 = 不排除任何工具
```

#### 实测数据（真机 A/B，同一 33999 字符工具输出）

用 `--mod-option outputFold=false` 对照，读 `model_request_end` 的真实 usage。第 2 轮请求的 `inputTokens` 增量就是折叠的收益：

| 配置 | tool_result 字符 | 第 2 轮 `inputTokens` | 省下 |
|---|---|---|---|
| 不折叠 | 33999 | 28775 | — |
| `outputFoldLimit=1000`（近似只给路径） | 1235 | 18461 | 10314（36%） |
| `outputFoldLimit=8000` | 8235 | 20567 | 8208（29%） |
| **默认 20000** | 10433 | 21267 | **7508（26%）** |

- **`cacheReadTokens` 全程不变**（约 17800）：折叠「本轮刚产生」的输出**不损失前缀缓存**——它本来就是未命中部分，所以这笔省是净赚的。这是 mod 用 `afterToolCall` 而非 `transformContext` 的关键理由。
- 换算率约 **3.0 字符/token**（重复性英文内容）。
- **默认 20000 偏保守**：只砍掉 26%，还有约 2800 token 可以再省。想更激进就调小 `outputFoldLimit`。
- **反过来也别全砍**：`limit=1000` 比默认只多省 2800 token/轮，但模型一旦需要中间内容就得发一轮 `read_file`（成本 ≈ 整段上下文 ≈ 22000 token）。所以**只要「需要深入」的概率超过约 13%，保留头尾就更划算**——这就是默认保留头尾的量化依据。

#### 与 CLI 内置截断的关系（实测，重要）

CLI **自己也有一套工具输出截断**，触发时会在结果尾部写：

```
[101,999 chars total, showing first 19,975 (25K token limit on tool outputs per request) ...]
[full output saved to: C:\Users\...\Temp\commandcode\toolout\2026-...-probe_big-xxx.log — read it with read_file (offset/limit) or grep]
```

实测的执行顺序是 **CLI 先截断 → `afterToolCall` 后跑**，两者叠加。所以这个 mod 的差异化价值在三处：

1. **触发更早**：本 mod 20000 **字符**（≈6.6k token），CLI 是 **25K token**（≈100K 字符）。中等大小的输出（20K–100K 字符）CLI 根本不管，只有本 mod 会处理。
2. **保留尾部**：CLI 的文案是「showing **first** 19,975」——**只留头部**，而报错、测试汇总、退出信息通常都在结尾。本 mod 保留头 80 行 + 尾 40 行，正好补上这个缺口。
3. **落盘在 workspace 内**：`.commandcode/temp/<sessionId>/` 跟着项目走、可随项目一起清理；CLI 落在系统 temp。两者 `read_file` 都读得到（实测确认，CLI 给的那个系统 temp 路径也能读）。

> 换句话说：它不是重复造轮子，而是把 CLI 的那道防线**提前、且补上尾部**。真嫌两者重叠，用 `outputFoldLimit` 调高到 CLI 阈值以上即可让它只在尾部缺失的场景生效。

### `mods/input-shortcuts.ts`

超长粘贴转成文件引用。

- 输入超过 8000 字符时，原文落盘到 `.commandcode/temp/<sessionId>/pasted/`，输入改写成「指令 + 头尾摘录」。模型**看得到**（照常走一个 turn），只是内容从内联变成引用。
- 改写文本必须是**指令式**的（「先 `read_file` 读取该文件，再回答末尾的问题」）而不是裸路径——否则模型不会去读。同时**保留末尾原文**，因为用户的提问通常在最后。
- 摘录只留 1600 字符（远小于触发阈值，否则等于没省）。行数少但字符多时按字符对半切，不会把内容重复两遍。
- 超过阈值但比摘录预算还短时不转换：折不动就没必要动。
- 转换后 `notify` 一次，告知「已转为文件引用、内容没丢、路径在哪」。**必须告知**——否则用户看到的输入和模型收到的不是一回事。
- fail-open：写盘失败就原样发出去，且不误报通知。

```powershell
cmd --mod-option inputShortcuts=false    # 关掉
cmd --mod-option pasteFoldLimit=20000    # 调阈值
```

- **硬边界（对着 CLI 实现核实过）**：CLI 的 `runModInputInterception` 显式跳过了这些输入，它们**都不会**进本 mod：
  - role 不是 `user`、`isAutomated`（自动化 turn）、`isMeta`、`isGoalContinuation`、空输入
  - **以及任何带图片的输入**（`(e.images?.length ?? 0) > 0` 直接 return）——所以「粘贴一张图 + 一段日志」是**整条**绕过，文本部分也不会被折叠
  - `cmd -p "..."` 的初始 prompt 同样不走这条通路（探针实测：factory 跑了、hook 注册了，但 `transformInput` 没被调用）
  - 因此这条规则**只能在交互式会话里验，无法 headless 验**
- `transformInput` 的返回值是 **await** 的（mod-host 里是 `await n.transformInput(...)`），异步受支持；本 mod 用不上，因为落盘是同步 IO。

> **为什么这里没有 `!cmd`**（曾经实现过，已删除）：CLI **原生就有 bash 模式**——空输入框打一个 `!` 键即切换（`isBashMode`），之后提交的输入 `role='bash'`，走 `resolveSubmitStartPlan` 的 `{kind:'bash'}` 分支本地执行（同样不进模型），并有专用的 `BashMessage` 组件做 `$ cmd` 渲染、输出回填与错误态。
> 也就是说原生版本的语义与曾经的 `!cmd` 完全一致，但**模式指示、专用 feed 条目、输出显示都更好**。复刻它只会更差，所以本 mod 只保留 CLI 没有的能力：长文本折叠。

### `mods/context-slim.ts`

> **默认关闭**：需 `--mod-option contextSlim=true` 显式开启。

接近上下文上限前，把**旧的巨型工具结果**换成「占位符 + 落盘路径」：

```
[cmdc-enhance:slimmed] 这条工具结果已归档以释放上下文（原 20238 字符，内容未丢失）
完整内容保存在 E:\...\.commandcode\temp\<sessionId>\slimmed\call_xxx.txt
需要时用 read_file 读取该文件（可配合 offset / limit 分段读），不要凭记忆猜测里面写了什么。
```

- **为什么需要它**：CLI 自带的自动压缩是**破坏性**的（`removeToolCallsExceptLast` 直接过滤掉 tool_use/tool_result 对，不留痕迹）。本 mod 是可恢复的——占位符给绝对路径，模型能 `read_file` 读回全文。所以在阈值上要**抢在 CLI 之前**动手：默认 **0.45**，而 CLI 是 0.5 / 0.8 / 0.9。
- **基于真实 usage 决策**：用 `model_request_end.inputTokens`（上游给的真实值），不是估算。CLI 的门控是「字符数 ÷ 3.5」的估算，而实测英文 4.96、**中文 1.94** 字符/token——中文会话会被低估约 45%，压缩触发得比预期晚。
- **只换文本、不删块**：删掉 `tool_result` 会让 assistant 的 `tool_use` 失去配对，那是 wire 格式错误。整块保留，只把里面的 text 换成占位符。
- **挑最大的、不是最旧的**：用最少的消息条数换到最多的空间，动到的消息越少，缓存影响面越小。
- **保护最近的消息**（`contextSlimKeepMessages`，默认 4 条）：它们多半是当前正在用的上下文。
- **两个门槛**：单个结果至少 `DEFAULT_MIN_UNIT_CHARS`（2000 字符）才值得换；能释放的总量不到 `contextSlimMinYield`（默认 20000 字符）就整体不动手——不值得为省一点而打乱前缀。
- 落盘失败就不替换：**没有回溯路径的归档等于删数据**。

```powershell
cmd --mod-option contextSlim=true              # 开启（默认关闭）
cmd --mod-option contextSlimThreshold=0.45     # 触发比例（须低于 CLI 的 0.5）
cmd --mod-option contextSlimMinYield=20000     # 释放量下限（字符）
cmd --mod-option contextSlimKeepMessages=4     # 保护的最近消息条数
```

#### 缓存代价：只在首次替换时付一次

`transformContext` 的结果**不写回** `state.messages`，所以每轮都要重做同样的替换。但占位符是**确定性**的（只由 tool_use_id 与落盘路径决定，不含时间戳/轮次），因此第 N 轮和第 N+1 轮送出的内容逐字节相同，**前缀缓存照常命中**——代价只在首次替换时付一次。这也是为什么这里绝不能在占位符里塞「剩余配额」「第几轮」这类每轮变化的量。

两道守卫防止每轮churn：

- **已归档的集合只增不改**：一旦某条被换掉，之后每轮都换回**同一段文本**（闭包状态，`session_start` 清零）。
- **同一个 usage 水平只动手一次**：`transformContext` 可能带着同一个还没更新的 usage 被重复调用；不加这道守卫，第二轮会把上一轮没挑完的也挑走，于是每轮都改前缀、每轮打爆缓存。只有 usage 真的又涨上来（说明上次释放得不够）才会再次动手。

> **注意**：新消息越过保护窗口时**会**新增归档（一次性的边界代价，无法避免）。保证是「已归档的内容不再变动」，不是「整个前缀永不变化」。

#### 实测（真机，5 次大工具输出）

| 轮次 | 工具结果字符 | 已归档条数 | 真实 `inputTokens` |
|---|---|---|---|
| 5 | 28,727 | 0 | 29,211 |
| 6 | **15,103** | **3** | **24,229** |
| 7 | 15,392 | 3 | 24,594 |

- 归档 3 条后工具内容少 13,624 字符，真实 usage 从未瘦身的 ~36K 降到 24,229；第 7 轮 `slimmedCount` 仍是 3，**没有 churn**。
- 模型成功 `read_file` 读回归档文件并正确复述其最后一行 —— 回溯闭环成立。
- **system prompt 完全不受影响**（模型确认 AGENTS.md 的项目边界规则与语言规则仍在上下文中）——这是设计使然：AGENTS.md 走 system prompt，而 `transformContext` 只动 `messages`。

#### 与其他 mod 的分工

| mod | 层次 | 默认 | 处理对象 | 效果 |
|---|---|---|---|---|
| `output-fold` | 第一层 | 开 | **最新**的工具结果 | 折叠成头尾，仍占约 12K 字符 |
| `context-slim` | 第二层 | **关** | **旧的**工具结果 | 整个换成一行路径，只占约 150 字符 |

`context-slim` **默认关闭**，要用得显式开 `--mod-option contextSlim=true`。开启后它应当与 `output-fold` 同时生效：`context-slim` 会把 `output-fold` 折过的内容进一步归档（那正是最该归档的一批）。早期版本里 `context-slim` 因为跳过带 `folded` 标记的内容而在开启配置下完全失效——真机验证时才发现，单测抓不到这种跨 mod 交互。

代价是回溯链变成两级：占位符 → `slimmed/` 文件（折过的文本）→ 其中记录的 `tool-output/` 路径（CLI 截断后的版本）→ CLI 的 `toolout` 文件（原始全文）。每级都给了路径，模型可以逐级追。

## 临时文件

`output-fold`、`input-shortcuts` 与 `context-slim` 把大内容写到这里：

```
<workspace>/.commandcode/temp/<sessionId>/tool-output/   被折叠掉的工具输出全文
<workspace>/.commandcode/temp/<sessionId>/pasted/        被改写成引用的超长输入原文
<workspace>/.commandcode/temp/<sessionId>/slimmed/       被归档的旧工具结果全文
```

- 按 `sessionId` 分桶（来自 `run_start` 事件），不同会话互不覆盖，连 `toolCallId` 撞车都安全；再按用途分组。
- 可以随时整个删掉，没有任何东西依赖它；拿不到 `sessionId` 时落到 `session/` 兜底目录。`.commandcode/` 已 gitignore。

> **为什么是项目级（实测结论，别再改成 `~/.commandcode/`）**：`read_file` **拒绝 `~/.commandcode/` 下的任何路径**，
> 报 `is outside workspace`。那里是 CLI 的配置与数据目录（`auth.json`、`providers.json`、`projects/` session 记录），有安全策略。
> 实测被拒的有：`~/.commandcode/temp/...`、`~/.commandcode/projects/<proj>/...` —— 名字上最像，恰恰是唯一不能用的地方。
> 文件写得进去、模型读不出来，折叠就从「省 token」变成「丢数据」。
>
> 而 home 下其它目录、系统 temp 实测**都读得到**，所以项目级并非硬约束，是选择：
> 跟着项目走、能随项目一起清理、不污染全局。CLI 自己把工具输出落在系统 temp（`%TEMP%\commandcode\toolout\`）也是这个道理——它不受影响。

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
3. 复用 `mods/lib/`，别复制粘贴：`flags`（开关判定）、`text`（字符度量与折叠）、`spill`（大文本落盘）、`shell`（命令构造）、`model-catalog`（模型名归一化与上下文上限解析）。放 `mods/lib/` 下的文件不会被当成 mod 加载。
4. `commandcode.mods` 的 glob 会自动带上新文件，无需改 `package.json`。
5. 完整 `ModApi` 契约见 cmdc 自带的 mod-builder 技能：`reference/api.md`、`reference/hooks-and-events.md`、`reference/ui.md`。

### 开关约定

- `--mod-option` 是**全局命名空间**，flag 名一律带 mod 前缀（`outputFold` / `inputShortcuts` / `contextWindow` …），否则不同 mod 会撞名。
- 新开关默认开启：`addFlag(name, {type:'boolean', default:true})`，判定统一走 `lib/flags` 的 `flagEnabled`（容错字符串 `false` / `0` / `no` / `off`，未设置时回落 default）。
- **默认关闭的开关**（如 `contextSlim`）：`addFlag` 写 `default:false`，且调用处要显式传第三参 `flagEnabled(cmd, 'x', false)` —— `flagEnabled` 的 fallback 参数自带默认值 `true`，不传就会在「拿不到 flag」时反手打开，与 `addFlag` 的默认值不一致，而且是静默的。
- **开关必须在运行时判定（实测教训，别踩）**：`cmd.getFlag()` 在 **factory 阶段恒为 default**，拿不到 `--mod-option` 的值；只有 harness bind 之后（`on` 回调 / hook 里）才返回真实值。所以 `addFlag` 在 factory 里声明，但**读取要放进 hook 或事件回调**。
  **不要在 factory 里写 `if (!flagEnabled(cmd, 'x')) return;`** —— 那样读到的是 default，开关永远失效，而且不会报错，是静默失效。
  ```ts
  // ✗ 错：factory 阶段读到 default，永远「开启」
  if (!flagEnabled(cmd, 'outputFold')) return;
  cmd.hooks({afterToolCall: ...});

  // ✓ 对：hook 里读，拿到的是真实值
  cmd.hooks({afterToolCall: () => {
    if (!flagEnabled(cmd, 'outputFold')) return undefined;
    ...
  }});
  ```

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
