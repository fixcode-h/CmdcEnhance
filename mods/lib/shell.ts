// shell 命令的构造：修 Windows 上 shell 命令输出的中文乱码。
//
// 两条来自 CLI 实现的硬约束（不是取舍）：
//  - CLI 的 runtime.shell.run 把子进程输出读成 String(chunk)：对 Buffer 就是硬编码
//    UTF-8 解码。中文系统上 cmd.exe 输出 GBK 字节 → 非法 UTF-8 → 变成 U+FFFD 替换字符，
//    原始字节不可逆丢失。所以只能改「命令让输出变成 UTF-8」，事后转码救不回来。
//  - cmd.exe 的消息编码在进程启动时按控制台代码页定死，之后再 chcp 也改不动本进程，
//    所以要再套一层：外层先切代码页，内层启动时就拿到 UTF-8。

/** 切到 UTF-8 代码页；`>nul` 吞掉 chcp 自己那一行输出。 */
export const CMD_PREFIX = 'chcp 65001>nul & ';

export interface ShellContext {
	readonly windows: boolean;
}

/**
 * 把命令包成「输出一定是 UTF-8」的形式；不需要包装时返回 undefined。
 * 已带前缀的命令不再重复包装（幂等）。
 *
 * `/d` 跳过 AutoRun 注册表项，`/s` 让首尾引号剥离规则确定（外层 CLI 也会再包一层引号），
 * 用 `&` 而不是 `&&` 分隔：退出码取最后一条命令，也就是原命令自己的。
 *
 * **必须双层**（实测）：外层 `chcp` 改变的是本进程的代码页，命令行里已经启动的那个
 * cmd.exe 改不动自己的编码，所以要再起一个内层 cmd.exe，让它在启动时就拿到 UTF-8。
 * 单层 `chcp 65001 & echo 中文` 实测**仍然乱码**。
 */
export function wrapShellCommand(command: string, context: ShellContext): string | undefined {
	if (!context.windows) return undefined;
	const head = command.trimStart();
	if (!head || head.startsWith('chcp 65001')) return undefined;
	return `${CMD_PREFIX}cmd /d /s /c "${command}"`;
}
