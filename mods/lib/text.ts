// 文本度量与折叠。output-fold 与 input-shortcuts 共用。
//
// 口径一律用**字符数**，不用 token：token 估算对中文偏差大（一个汉字约 1 token，
// 但英文 4 字符才 1 token），字符数是唯一诚实的度量。阈值感觉不对就调 flag。

/** 折叠标记。幂等判定靠它——第二次看到自己留下的标记就跳过。 */
export const FOLD_MARKER_TAG = '[cmdc-enhance:folded]';

export interface FoldMarkerInfo {
	readonly omittedLines: number;
	readonly omittedChars: number;
}

export interface FoldOptions {
	/** 超过这个字符数才折叠，同时也是折叠后的目标大小。 */
	readonly maxChars: number;
	/** 保留头部行数。 */
	readonly headLines: number;
	/** 保留尾部行数。 */
	readonly tailLines: number;
	/** 中间省略处的提示文本（由调用方给出，含回溯路径）。 */
	readonly marker: (info: FoldMarkerInfo) => string;
}

export interface FoldResult {
	readonly folded: boolean;
	readonly text: string;
	readonly omittedLines: number;
	readonly omittedChars: number;
}

export function clampChars(text: string, maxChars: number): string {
	if (maxChars <= 0) return '';
	return text.length <= maxChars ? text : text.slice(0, maxChars);
}

/**
 * 保留**结尾**的 maxChars 个字符。
 * 尾部必须从后面截：输出的最后几行往往是最有用的（报错、汇总），从前面截会把它丢掉。
 */
export function clampTailChars(text: string, maxChars: number): string {
	if (maxChars <= 0) return '';
	return text.length <= maxChars ? text : text.slice(text.length - maxChars);
}

/**
 * 保留头尾、中间换成 marker。
 *
 * 触发条件是**字符数**超过 maxChars。两条分支：
 *  - 行数够多：按行取头尾，再各自按字符上限削一刀 —— 防「80 行里每行 1 万字符」把
 *    头尾本身撑爆（巨型 JSON 就是这个形状）。
 *  - 行数很少（单行几十万字符）：整体按字符对半切，按行取头尾会取到同一段。
 *
 * 头尾长度之和 <= maxChars < text.length，所以两段永不重叠、omittedChars 恒 > 0。
 */
export function foldText(text: string, options: FoldOptions): FoldResult {
	const {maxChars, headLines, tailLines, marker} = options;
	if (text.length <= maxChars) {
		return {folded: false, text, omittedLines: 0, omittedChars: 0};
	}

	const headChars = Math.max(1, Math.floor(maxChars * 0.6));
	const tailChars = Math.max(1, maxChars - headChars);
	const lines = text.split('\n');

	let head: string;
	let tail: string;
	let keptLines: number;

	if (lines.length > headLines + tailLines) {
		const headPart = lines.slice(0, headLines);
		const tailPart = lines.slice(-tailLines);
		head = clampChars(headPart.join('\n'), headChars);
		tail = clampTailChars(tailPart.join('\n'), tailChars);
		keptLines = headPart.length + tailPart.length;
	} else {
		head = clampChars(text, headChars);
		tail = clampTailChars(text, tailChars);
		keptLines = lines.length;
	}

	const omittedChars = text.length - head.length - tail.length;
	const omittedLines = Math.max(0, lines.length - keptLines);
	return {
		folded: true,
		text: head + marker({omittedLines, omittedChars}) + tail,
		omittedLines,
		omittedChars,
	};
}
