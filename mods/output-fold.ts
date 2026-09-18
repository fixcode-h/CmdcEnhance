// 折叠超长的工具输出，只把头尾留给模型，全文落盘。
//
// 为什么值得做：工具结果会进上下文，而且**每一轮都被重发一遍**。`npm test` 吐几千行、
// read_file 读大文件，这些文本此后一直在，每轮重新计费。CLI 默认全量给模型。
//
// 机制：`afterToolCall` 可以 `return {content}` **整体替换**模型看到的结果（mod 之间链式
// 传递），且改的是本轮刚产生的结果——它本来就是未命中 prompt 缓存的新内容，替换不损失
// 缓存。换掉它也不动 state.messages，磁盘 transcript 仍是完整版。
//
// 三条纪律：
//  1. **必须给回溯指针**。被省掉的中间部分是真没了，占位符里要给绝对路径 + 「用 read_file
//     读，别重跑原命令」。没有它，模型只会瞎猜或反复重跑同一条命令，反而更贵。
//  2. **落盘必须在 workspace 内**（read_file 只认 workspace 内的路径），所以走
//     `<cwd>/.commandcode/temp/<sessionId>/tool-output/`，不能用系统 temp。
//  3. **fail-open**。落盘失败就不折叠——宁可留着占地方，也不能把没备份的内容丢掉。
//
// 形状问题：`result` 可能是纯字符串，也可能是 content block 数组（mod-builder 的
// kitchen-sink 示例里就在判 `typeof result !== 'string'`）。所以这里只认这两种形状，
// 认不出来一律放行。折叠目标是**单个最大的 text block**——巨型输出几乎总是这个形状，
// 比"多个中等块加起来超标"的情况常见得多，逻辑也简单可预测。

import type {ModApi} from '@commandcode/harness';
import {flagEnabled, flagList, flagPositiveInt} from './lib/flags';
import {spillText} from './lib/spill';
import {FOLD_MARKER_TAG, foldText, type FoldMarkerInfo} from './lib/text';

/** 超过这么多字符才折叠；同时也是折叠后的目标大小。 */
export const DEFAULT_LIMIT_CHARS = 20_000;
export const HEAD_LINES = 80;
export const TAIL_LINES = 40;

/**
 * 默认不折叠的工具：它们的返回值是模型必须精确读到的确认信息，而且通常很短。
 * 传空串（`--mod-option outputFoldSkip=`）表示不过滤。
 */
export const DEFAULT_SKIP = ['edit_file', 'write_file', 'todo_write'];

const GROUP = 'tool-output';

export interface TextTarget {
	readonly text: string;
	readonly chars: number;
}

function isTextBlock(value: unknown): value is {type: 'text'; text: string} {
	if (typeof value !== 'object' || value === null) return false;
	const block = value as {type?: unknown; text?: unknown};
	return block.type === 'text' && typeof block.text === 'string';
}

/** 找出结果里最大的那段文本；形状不认识、或压根没有文本块时返回 undefined。 */
export function findLargestText(result: unknown): TextTarget | undefined {
	if (typeof result === 'string') return {text: result, chars: result.length};
	if (!Array.isArray(result)) return undefined;
	let best: TextTarget | undefined;
	for (const block of result) {
		if (!isTextBlock(block)) continue;
		if (!best || block.text.length > best.chars) best = {text: block.text, chars: block.text.length};
	}
	return best;
}

/**
 * 只替换最大的那段文本，其余块（图片等）原样保留。
 * 形状不认识或没有文本块时原样返回——调用方不必为此分支。
 */
export function mapLargestText(result: unknown, map: (text: string) => string): unknown {
	if (typeof result === 'string') return map(result);
	if (!Array.isArray(result)) return result;
	const target = findLargestText(result);
	if (!target) return result;
	return result.map(block =>
		isTextBlock(block) && block.text === target.text ? {...block, text: map(block.text)} : block,
	);
}

/** 折叠处插进正文的提示；`path` 是落盘后的绝对路径（必有，否则不折叠）。 */
export function buildFoldMarker(path: string, info: FoldMarkerInfo): string {
	// 单行超长（巨型 JSON）时 omittedLines 是 0，报「0 行」只是噪音。
	const omitted =
		info.omittedLines > 0
			? `${info.omittedLines} 行（${info.omittedChars} 字符）`
			: `${info.omittedChars} 字符`;
	return (
		`\n\n${FOLD_MARKER_TAG} 已省略 ${omitted}\n` +
		`完整输出已保存到 ${path}\n` +
		'需要中间部分时用 read_file 读取该文件（可配合 offset / limit），不要重跑原命令。\n\n'
	);
}

export default function outputFoldMod(cmd: ModApi): void {
	cmd.addFlag('outputFold', {
		type: 'boolean',
		default: true,
		description: '折叠超长工具输出：只留头尾，全文落盘到 .commandcode/temp。',
	});
	cmd.addFlag('outputFoldLimit', {
		type: 'string',
		default: String(DEFAULT_LIMIT_CHARS),
		description: `超过多少字符才折叠（默认 ${DEFAULT_LIMIT_CHARS}）。`,
	});
	cmd.addFlag('outputFoldSkip', {
		type: 'string',
		default: DEFAULT_SKIP.join(','),
		description: '不折叠的工具名，逗号分隔；传空串表示不过滤。',
	});

	// 落盘目录按会话分桶（run_start 带 sessionId），跨会话互不覆盖。
	// 首个 run 之前不会有工具调用，所以这里拿不到值时不会真的发生写盘。
	let sessionKey = '';

	cmd.on('run_start', event => {
		if (typeof event.sessionId === 'string' && event.sessionId) sessionKey = event.sessionId;
	});

	// 开关必须在**运行时**读：`cmd.getFlag` 在 factory 阶段拿不到 --mod-option 的值
	// （实测 factory 里恒为 default），只有 harness bind 之后才返回真实值。
	cmd.hooks({
		afterToolCall: ({toolCallId, toolName, result}) => {
			if (!flagEnabled(cmd, 'outputFold')) return undefined;
			if (flagList(cmd, 'outputFoldSkip', DEFAULT_SKIP).includes(toolName)) return undefined;

			const target = findLargestText(result);
			if (!target) return undefined;
			if (target.chars <= flagPositiveInt(cmd, 'outputFoldLimit', DEFAULT_LIMIT_CHARS)) {
				return undefined;
			}
			// 幂等：看到自己留下的标记就不再折。
			if (target.text.includes(FOLD_MARKER_TAG)) return undefined;

			const file = spillText({
				cwd: cmd.cwd,
				sessionKey,
				group: GROUP,
				name: `${toolCallId}.txt`,
				text: target.text,
			});
			// fail-open：没备份就不折，绝不丢内容。
			if (!file) return undefined;

			const folded = foldText(target.text, {
				maxChars: flagPositiveInt(cmd, 'outputFoldLimit', DEFAULT_LIMIT_CHARS),
				headLines: HEAD_LINES,
				tailLines: TAIL_LINES,
				marker: info => buildFoldMarker(file.abs, info),
			});
			if (!folded.folded) return undefined;

			return {content: mapLargestText(result, text => (text === target.text ? folded.text : text))};
		},
	});
}
