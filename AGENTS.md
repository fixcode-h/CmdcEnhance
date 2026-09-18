# Memory

## 项目边界（硬性规则）

- **所有改动只落在本仓库内**：`mods/`、`tests/`、`types/`、`README.md` 等。这是本仓库存在的全部理由。
- **绝不修改 cmdc 源码**。不碰全局安装目录（`.../npm/node_modules/command-code/`）、不碰 `node_modules/`、不做 patch / 覆盖 / 打补丁。cmdc 升级不得被本仓库的任何内容阻断。
- 需要新能力时，用**既有的扩展点**引入，优先级从高到低：
  1. 新建一个 mod（`mods/xxx.ts`，默认导出 `(cmd: ModApi) => void`）；
  2. 扩展现有 mod；
  3. 用 `cmd.addFlag` / `cmd.on` / `cmd.ui` 等 `ModApi` 成员组合出想要的行为；
  4. 实在缺类型签名，只在 `types/commandcode-harness.d.ts` 里**补声明**——那只是本地的类型桩，不是 cmdc 本体。
- **mod API 做不到的事，不靠改源码解决**：写成代码注释 + README 里的「硬约束」说明（现有 `mods/context-usage.ts` 开头就是范例），然后在 mod 内部找能在现有 API 上成立的绕法。不确定某个 API 是否存在时，先查 cmdc 自带的 mod-builder 技能（`reference/api.md`、`reference/hooks-and-events.md`、`reference/ui.md`），查不到就当作不存在，不要靠猜。

## 其他

- 项目概览、安装方式、mod 清单见 `README.md`；开发命令：`npm test`、`npm run typecheck`。
- 改完 mod 后在 cmdc 会话里 `/reload` 生效。
