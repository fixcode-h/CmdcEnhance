// 超长粘贴转成文件引用。
//
// 规则：输入超过 pasteFoldLimit（默认 8000 字符）时，原文落盘，输入改写成
// 「前言 + 头尾摘录 + 绝对路径 + 先 read_file」，返回 `{action:'transform'}`。
// 模型**看得到**这条输入（照常走一个正常 turn），只是内容从内联变成引用。
//
// 三条硬边界（API 如此，不是取舍；已对着 CLI 的实现核实过）：
//  - 只拦**用户真实敲入**的文本。CLI 的 runModInputInterception 显式跳过了：
//    role 非 user、isAutomated / isMeta / isGoalContinuation、空输入、**以及任何带图片的输入**。
//    所以「粘贴一张图 + 一段日志」会整条绕过本 mod —— 文本部分也不会被折叠。
//  - 返回值是 **await** 的（mod-host 里是 `await n.transformInput(...)`），异步受支持；
//    本 mod 用不上，因为落盘是同步 IO。
//  - 落盘位置见 lib/spill.ts：**不能**放 `~/.commandcode/`（read_file 会拒绝）。
//
// **不做 `!cmd`**：CLI 原生已有 bash 模式（空输入框打单个 `!` 切换，走专用 BashMessage
// 渲染、输出回填、错误态、状态栏指示），语义与本 mod 曾实现的一致（本地跑、不进模型）。
// 复刻它只会更差，所以这里只保留 CLI 没有的能力：长文本折叠。

import type {ModApi} from '@commandcode/harness';
import {flagEnabled, flagPositiveInt} from './lib/flags';
import {shortHash, spillText} from './lib/spill';
import {FOLD_MARKER_TAG, foldText} from './lib/text';

/** 超过这么多字符的输入改成文件引用。 */
export const DEFAULT_PASTE_LIMIT = 8000;
/** 改写后留在输入里的摘录预算（远小于触发阈值，否则等于没省）。 */
export const PASTE_KEEP_CHARS = 1600;
export const PASTE_HEAD_LINES = 20;
export const PASTE_TAIL_LINES = 20;

const GROUP_PASTED = 'pasted';

export function shouldFoldPaste(text: string, maxChars: number): boolean {
	return text.length > maxChars;
}

/**
 * 把超长输入改写成「文件引用 + 头尾摘录」；不需要改写时返回 undefined。
 *
 * 摘录复用 foldText：它保证头尾不重叠（按字符对半切那条分支），行数少但字符多的
 * 输入才不会把自己重复两遍。
 */
export function buildPasteRewrite(input: {
	readonly text: string;
	readonly path: string;
}): string | undefined {
	const folded = foldText(input.text, {
		maxChars: PASTE_KEEP_CHARS,
		headLines: PASTE_HEAD_LINES,
		tailLines: PASTE_TAIL_LINES,
		marker: info => {
			// 单行超长时 omittedLines 是 0，报「0 行」只是噪音。
			const omitted =
				info.omittedLines > 0
					? `${info.omittedLines} 行（${info.omittedChars} 字符）`
					: `${info.omittedChars} 字符`;
			return (
				`\n\n${FOLD_MARKER_TAG} 中间已省略 ${omitted}\n` +
				`完整内容保存在 ${input.path}\n` +
				'用 read_file 读取该文件继续，不要凭开头结尾猜中间内容。\n\n'
			);
		},
	});
	if (!folded.folded) return undefined;
	const preamble =
		`（本次输入过长，共 ${input.text.length} 字符；下文只保留头尾，完整内容已转为文件引用。）\n` +
		`完整内容保存在 ${input.path}\n` +
		'先 read_file 读取该文件，再回答末尾的问题。\n';
	return `${preamble}\n${folded.text}`;
}

export default function inputShortcutsMod(cmd: ModApi): void {
	cmd.addFlag('inputShortcuts', {
		type: 'boolean',
		default: true,
		description: '超长输入自动转为文件引用，避免把大段文本塞进上下文。',
	});
	cmd.addFlag('pasteFoldLimit', {
		type: 'string',
		default: String(DEFAULT_PASTE_LIMIT),
		description: `输入超过多少字符改成文件引用（默认 ${DEFAULT_PASTE_LIMIT}）。`,
	});

	// 落盘目录按会话分桶（run_start 带 sessionId），跨会话互不覆盖。
	let sessionKey = '';

	cmd.on('run_start', event => {
		if (typeof event.sessionId === 'string' && event.sessionId) sessionKey = event.sessionId;
	});

	// 开关必须在**运行时**读：`cmd.getFlag` 在 factory 阶段恒为 default（实测），
	// 只有 harness bind 之后才拿得到 --mod-option 的真实值。
	cmd.hooks({
		transformInput: ({text}) => {
			if (!flagEnabled(cmd, 'inputShortcuts')) return {action: 'continue'};
			if (!shouldFoldPaste(text, flagPositiveInt(cmd, 'pasteFoldLimit', DEFAULT_PASTE_LIMIT))) {
				return {action: 'continue'};
			}

			const file = spillText({
				cwd: cmd.cwd,
				sessionKey,
				group: GROUP_PASTED,
				name: `${Date.now()}-${shortHash(text)}.md`,
				text,
			});
			// fail-open：写不进去就原样发给模型。
			if (!file) return {action: 'continue'};

			const rewritten = buildPasteRewrite({text, path: file.abs});
			// 折不动（还没摘录预算长）就没必要转换。
			if (rewritten === undefined) return {action: 'continue'};

			// 用户的原文被改写成了引用，必须告知——否则他看到的输入与模型收到的不是一回事。
			cmd.ui.notify(
				`输入过长（${text.length} 字符），已转为文件引用：${file.rel}\n` +
					'模型会先读取该文件，你原本的内容没有丢失，可在上面路径查看。',
			);
			return {action: 'transform', text: rewritten};
		},
	});
}
