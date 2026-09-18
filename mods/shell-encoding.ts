// 修 Windows 上 SHELL 工具（shell_command）的中文乱码。
//
// 三条来自 CLI 实现的硬约束（不是取舍）：
//  - CLI 的 runtime.shell.run 把子进程输出读成 String(chunk)：对 Buffer 就是硬编码 UTF-8
//    解码。中文系统上 cmd.exe 输出 GBK 字节 → 非法 UTF-8 → 变成 U+FFFD 替换字符，原始
//    字节不可逆丢失。所以只能改写「输出的字节」，事后在 afterToolCall 里转码救不回来。
//  - 该工具用 Node 的 shell:true 执行（即 ComSpec = cmd.exe，与 PSModulePath 无关），
//    spawn 时带 windowsHide：每条命令一个独立控制台。cmd.exe 的消息编码在进程启动时按
//    控制台代码页定死，之后再 chcp 也改不动本进程 —— 所以要再套一层 cmd /c。这也意味着
//    「预热」代码页对后续命令无效。
//  - 因此只有逐条包装这条路；CLI 在 Windows 上不会用 PowerShell 执行本工具，别按
//    PSModulePath 去猜分支 —— 那样会把 PowerShell 语法喂给 cmd.exe。
//
// 代价：内层 cmd.exe 在 65001 下用英文消息资源，cmd 自身的中文报错会变成英文；
// 命令自己 echo 的中文、以及外部程序在 65001 下的输出都是 UTF-8，显示正常。
//
// 命令的包装逻辑（含上述所有细节）在 lib/shell.ts，与本 mod 的 `!cmd` 快捷方式共用。

import type {ModApi} from '@commandcode/harness';
import {flagEnabled} from './lib/flags';
import {wrapShellCommand} from './lib/shell';

/** CLI 执行 shell 命令的工具名（见 mod-builder 的 block-dangerous-commands 示例）。 */
const SHELL_TOOL = 'shell_command';

export default function shellEncodingMod(cmd: ModApi): void {
	cmd.addFlag('shellEncoding', {
		type: 'boolean',
		default: true,
		description: 'Windows shell 命令的输出编码修复；关掉即回到 CLI 原始行为（中文会乱码）。',
	});

	// 开关必须在**运行时**读：`cmd.getFlag` 在 factory 阶段恒为 default（实测），
	// 只有 harness bind 之后才拿得到 --mod-option 的真实值。
	cmd.hooks({
		beforeToolCall: ({toolName, input}) => {
			if (!flagEnabled(cmd, 'shellEncoding')) return undefined;
			if (toolName !== SHELL_TOOL) return undefined;
			if (typeof input.command !== 'string') return undefined;
			const command = wrapShellCommand(input.command, {
				windows: process.platform === 'win32',
			});
			if (command === undefined) return undefined;
			return {input: {...input, command}};
		},
	});
}
