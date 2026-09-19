// 上下文瘦身：在接近上限前，把**旧的巨型工具结果**换成「占位符 + 落盘路径」。
//
// 为什么需要它（实测）：
//  - CLI 自己有分级压缩（阈值 0.5 / 0.8 / 0.9），但那三级都是**破坏性**的：
//    `removeToolCallsExceptLast` 直接过滤掉 tool_use / tool_result 对，不留任何痕迹，
//    内容永久丢失。
//  - 它的门控 token 数是**估算**的（字符数 ÷ 3.5），实测英文 4.96、中文 1.94 字符/token，
//    所以中文会话会被低估约 45%，压缩触发得比预期晚。
//  - 它的截断是按**每次工具调用**算的，不是每轮请求：同轮 4 次并行大调用实测多进
//    30446 token（单次只有 7638）。
//  - 真超限是**不可重试的 400**，整个 run 失败（实测：maximum context length is 1048576）。
//
// 本 mod 的做法是可恢复的：占位符里给**绝对路径**，模型能 read_file 读回全文。
// 所以在阈值上要**抢在 CLI 的破坏性裁剪（0.5）之前**动手，默认 0.45。
// 本 mod **默认关闭**，需 `--mod-option contextSlim=true` 显式开启。
//
// 三条纪律：
//  1. **只换文本、不删块**。删掉 tool_result 会让 assistant 的 tool_use 失去配对，
//     直接违反 wire 格式。整块保留，只把里面的 text 换成占位符。
//  2. **替换必须字节稳定**。transformContext 的结果不写回 state.messages，所以每轮都要
//     重做同样的替换；只要输出逐字节相同，prompt 前缀缓存就照常命中，代价只在**首次**
//     替换时付一次。所以占位符里绝不能出现时间戳 / 轮次号 / 剩余配额这类每轮变化的量。
//  3. **基于真实 usage 决策**。`model_request_end.inputTokens` 是上游给的真实值，
//     不受估算偏差影响——这是本 mod 相对 CLI 门控的唯一优势，别退回估算。

import type {ModApi} from '@commandcode/harness';
import {flagEnabled, flagPositiveInt} from './lib/flags';
import {
	asPositiveNumber,
	loadCatalogLimits,
	loadConfigModel,
	loadProviderLimits,
	resolveLimit,
} from './lib/model-catalog';
import {spillText} from './lib/spill';

/** 占位符标记。幂等与「已处理」判定靠它。 */
export const SLIM_MARKER_TAG = '[cmdc-enhance:slimmed]';

/** 触发比例。**必须低于 CLI 的 0.5**，否则 CLI 会先做破坏性裁剪。 */
export const DEFAULT_THRESHOLD = 0.45;
/** 触发后压到哪：比阈值低 0.1，留出余量避免下一轮立刻又触发。 */
export const TARGET_MARGIN = 0.1;
/** 至少能释放这么多字符才动手，否则不值得付那一次缓存代价。 */
export const DEFAULT_MIN_YIELD_CHARS = 20_000;
/** 单个工具结果小于这个字符数就不值得换（占位符本身也有成本）。 */
export const DEFAULT_MIN_UNIT_CHARS = 2_000;
/** 最近这么多条消息永不触碰：它们多半是当前正在用的上下文。 */
export const DEFAULT_KEEP_MESSAGES = 4;

const GROUP = 'slimmed';

/** 字符/token 的兜底估值；有真实数据时会被替换。 */
const FALLBACK_CHARS_PER_TOKEN = 3;

export interface ToolResultRef {
	readonly messageIndex: number;
	readonly blockIndex: number;
	/** `tool_result.tool_use_id`，与 afterToolCall 的 toolCallId 是同一个 id。 */
	readonly toolUseId: string;
	readonly text: string;
	readonly chars: number;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}

/** 把 tool_result 的 content 拍平成纯文本（它可能是字符串，也可能是 block 数组）。 */
function textOfToolResult(content: unknown): string {
	if (typeof content === 'string') return content;
	if (!Array.isArray(content)) return '';
	let out = '';
	for (const part of content) {
		const block = asRecord(part);
		if (block?.type === 'text' && typeof block.text === 'string') out += block.text;
	}
	return out;
}

/** 收集所有 tool_result 引用。形状不认识的一律跳过（fail-open）。 */
export function collectToolResults(messages: readonly unknown[]): ToolResultRef[] {
	const out: ToolResultRef[] = [];
	messages.forEach((message, messageIndex) => {
		const content = asRecord(message)?.content;
		if (!Array.isArray(content)) return;
		content.forEach((block, blockIndex) => {
			const record = asRecord(block);
			if (record?.type !== 'tool_result') return;
			const toolUseId = typeof record.tool_use_id === 'string' ? record.tool_use_id : '';
			if (!toolUseId) return;
			const text = textOfToolResult(record.content);
			out.push({messageIndex, blockIndex, toolUseId, text, chars: text.length});
		});
	});
	return out;
}

/** 消息里所有文本的总字符数，用来标定「字符/token」密度。 */
export function countMessageChars(messages: readonly unknown[]): number {
	let total = 0;
	const walk = (value: unknown): void => {
		if (typeof value === 'string') {
			total += value.length;
			return;
		}
		if (Array.isArray(value)) {
			for (const item of value) walk(item);
			return;
		}
		const record = asRecord(value);
		if (!record) return;
		// 只数文本载荷，别把 role / type / id 这类结构字段算进去。
		if (typeof record.text === 'string') total += record.text.length;
		if (typeof record.content === 'string') total += record.content.length;
		else if (record.content !== undefined) walk(record.content);
	};
	walk(messages);
	return total;
}

/**
 * 是否**已经归档过**（本 mod 自己处理过的）——已归档的不再处理。
 *
 * 注意**不要**把 output-fold 的标记也算进来：那是两个不同的优化层次。fold 只把头尾留下、
 * 仍占着上万字符；slim 可以把这上万字符整个换成一行路径。默认配置下两个 mod 同时生效，
 * 若这里连 fold 过的也跳过，slim 就永远无事可做——而 fold 过的正是最该归档的那批。
 */
export function isAlreadySlimmed(text: string): boolean {
	return text.includes(SLIM_MARKER_TAG);
}

export interface SelectInput {
	readonly refs: readonly ToolResultRef[];
	readonly messageCount: number;
	/** 最近这么多条消息不碰。 */
	readonly keepMessages: number;
	/** 单个结果至少这么大才值得换。 */
	readonly minUnitChars: number;
	/** 想释放多少字符（达到目标比例所需的量）。 */
	readonly needChars: number;
	/** 最少能释放这么多才动手；可释放量低于它就没有意义，不做。 */
	readonly minYieldChars: number;
	/** 已替换过的 id，跳过。 */
	readonly alreadySlimmed: ReadonlySet<string>;
}

/**
 * 挑要替换的目标：从**最大**的开始，直到够 needChars。
 *
 * 挑最大的而不是最旧的，是为了「用最少的消息条数换到最多的空间」——动到的消息越少，
 * 缓存被影响的面越小。返回空数组表示不值得动手。
 *
 * `needChars` 与 `minYieldChars` 是两件事：前者是「要压到目标需要释放多少」，
 * 后者是「少于这个量就不值得付那一次缓存代价」。可释放量够不着 minYield 时直接放弃，
 * 而不是把能删的都删了——那既没达到目标，又白白打乱前缀。
 */
export function selectSlimTargets(input: SelectInput): ToolResultRef[] {
	const cutoff = input.messageCount - input.keepMessages;
	const eligible = input.refs
		.filter(ref => ref.messageIndex < cutoff)
		.filter(ref => ref.chars >= input.minUnitChars)
		.filter(ref => !input.alreadySlimmed.has(ref.toolUseId))
		.filter(ref => !isAlreadySlimmed(ref.text))
		.sort((a, b) => b.chars - a.chars);

	let available = 0;
	for (const ref of eligible) available += ref.chars;
	if (available < input.minYieldChars) return [];

	const picked: ToolResultRef[] = [];
	let freed = 0;
	for (const ref of eligible) {
		if (freed >= input.needChars) break;
		picked.push(ref);
		freed += ref.chars;
	}
	return picked;
}

/** 替代原文本的占位符。**必须字节稳定**——不能含时间戳 / 轮次 / 剩余量。 */
export function buildSlimPlaceholder(path: string, chars: number): string {
	return (
		`${SLIM_MARKER_TAG} 这条工具结果已归档以释放上下文（原 ${chars} 字符，内容未丢失）\n` +
		`完整内容保存在 ${path}\n` +
		'需要时用 read_file 读取该文件（可配合 offset / limit 分段读），不要凭记忆猜测里面写了什么。'
	);
}

/**
 * 把命中的 tool_result 的**文本**换成占位符，其余一切原样保留。
 *
 * 只换文本、不动块结构：删掉 tool_result 会让 assistant 的 tool_use 失去配对，
 * 那是 wire 格式错误，不是保守与否的问题。
 * 无改动时返回**同一个引用**，向 hook 表示「没变」。
 */
export function withSlimmedText(
	messages: readonly unknown[],
	replacements: ReadonlyMap<string, string>,
): readonly unknown[] {
	if (replacements.size === 0) return messages;
	let touched = false;
	const out = messages.map(message => {
		const record = asRecord(message);
		const content = record?.content;
		if (!record || !Array.isArray(content)) return message;
		let blockTouched = false;
		const nextContent = content.map(block => {
			const blockRecord = asRecord(block);
			if (blockRecord?.type !== 'tool_result') return block;
			const id = typeof blockRecord.tool_use_id === 'string' ? blockRecord.tool_use_id : '';
			const replacement = replacements.get(id);
			if (replacement === undefined) return block;
			blockTouched = true;
			return {...blockRecord, content: [{type: 'text', text: replacement}]};
		});
		if (!blockTouched) return message;
		touched = true;
		return {...record, content: nextContent};
	});
	return touched ? out : messages;
}

function clamp(value: number, min: number, max: number): number {
	if (!Number.isFinite(value)) return min;
	return Math.min(max, Math.max(min, value));
}

export default function contextSlimMod(cmd: ModApi): void {
	// 默认关闭：归档会改写送进模型的消息，先要求显式开启（--mod-option contextSlim=true）。
	cmd.addFlag('contextSlim', {
		type: 'boolean',
		default: false,
		description: '接近上下文上限前，把旧的巨型工具结果归档成占位符 + 文件路径（默认关闭）。',
	});
	cmd.addFlag('contextSlimThreshold', {
		type: 'string',
		default: String(DEFAULT_THRESHOLD),
		description: `占用超过这个比例就瘦身（默认 ${DEFAULT_THRESHOLD}，须低于 CLI 自动压缩的 0.5）。`,
	});
	cmd.addFlag('contextSlimMinYield', {
		type: 'string',
		default: String(DEFAULT_MIN_YIELD_CHARS),
		description: `至少要能释放这么多字符才动手（默认 ${DEFAULT_MIN_YIELD_CHARS}）。`,
	});
	cmd.addFlag('contextSlimKeepMessages', {
		type: 'string',
		default: String(DEFAULT_KEEP_MESSAGES),
		description: `最近这么多条消息不触碰（默认 ${DEFAULT_KEEP_MESSAGES}）。`,
	});
	// 与 context-usage 同名：只在它被禁用时补位，两处读的是同一个值。
	cmd.addFlag('contextWindow', {
		type: 'string',
		description: '上下文上限（token 数）。用于目录里查不到的模型。',
	});

	let model = loadConfigModel();
	// 真实 usage，来自上游（不是估算）。整个 mod 的决策都基于它。
	let lastInputTokens = 0;
	// 消息文本总字符数，用来标定密度。
	let lastMessageChars = 0;
	let sessionKey = '';
	let subagentDepth = 0;
	// 上次「动手」时所依据的 usage 水平。同一个水平只动手一次：
	// transformContext 可能带着**同一个**（还没更新过的）usage 被重复调用，
	// 若不加这道守卫，第二轮会把上一轮没挑完的也挑走，于是每轮都改前缀、每轮打爆缓存。
	// 只有 usage 真的又涨上来了（说明上次释放得不够）才会再次动手。
	let lastActedAtTokens = 0;
	// 已归档的 tool_result：id → 落盘信息。闭包状态，跨轮保持，
	// 让「已替换的集合」稳定增长，而不是每轮重新挑一批（那会每轮都打爆缓存）。
	const slimmed = new Map<string, {path: string; chars: number}>();

	const applySlimmed = (messages: readonly unknown[]): readonly unknown[] => {
		if (slimmed.size === 0) return messages;
		const replacements = new Map<string, string>();
		for (const [id, info] of slimmed) {
			replacements.set(id, buildSlimPlaceholder(info.path, info.chars));
		}
		return withSlimmedText(messages, replacements);
	};

	cmd.on('run_start', event => {
		if (typeof event.sessionId === 'string' && event.sessionId) sessionKey = event.sessionId;
	});

	cmd.on('model_request_start', event => {
		if (typeof event.model === 'string' && event.model) model = event.model;
	});

	cmd.on('model_request_end', event => {
		if (subagentDepth > 0) return;
		if (typeof event.model === 'string' && event.model) model = event.model;
		const usage = event.usage;
		const input = usage?.inputTokens ?? 0;
		if (input > 0) lastInputTokens = input;
	});

	cmd.on('subagent_start', () => {
		subagentDepth += 1;
	});

	cmd.on('subagent_stop', () => {
		subagentDepth = Math.max(0, subagentDepth - 1);
	});

	cmd.on('session_start', () => {
		lastInputTokens = 0;
		lastMessageChars = 0;
		subagentDepth = 0;
		lastActedAtTokens = 0;
		slimmed.clear();
	});

	// 开关必须在**运行时**读：cmd.getFlag 在 factory 阶段恒为 default（实测过）。
	cmd.hooks({
		transformContext: ({messages}) => {
			const list = Array.isArray(messages) ? messages : [];
			// 第三参必须显式给 false：flagEnabled 的 fallback 自带默认值 true，
			// 不传就会在「拿不到 flag」时反手打开，与 addFlag 的默认值不一致。
			if (!flagEnabled(cmd, 'contextSlim', false)) return list;
			if (lastInputTokens <= 0) return list;

			const override = asPositiveNumber(Number(cmd.getFlag('contextWindow')));
			const limit = resolveLimit({
				model,
				override,
				providerLimits: loadProviderLimits(),
				catalogLimits: loadCatalogLimits(),
			}).limit;
			if (limit <= 0) return list;

			lastMessageChars = countMessageChars(list);
			const ratio = lastInputTokens / limit;
			const threshold = clamp(
				Number(cmd.getFlag('contextSlimThreshold')) || DEFAULT_THRESHOLD,
				0.05,
				0.95,
			);

			// 已经不超标：仍然把**之前**的替换重新贴一遍，否则前缀会回退、缓存全废。
			if (ratio < threshold) return applySlimmed(list);
			// 同一个 usage 水平只动手一次（见 lastActedAtTokens 的说明）。
			if (lastInputTokens <= lastActedAtTokens) return applySlimmed(list);

			const minYieldChars = flagPositiveInt(
				cmd,
				'contextSlimMinYield',
				DEFAULT_MIN_YIELD_CHARS,
			);
			const keepMessages = flagPositiveInt(cmd, 'contextSlimKeepMessages', DEFAULT_KEEP_MESSAGES);
			// 目标压到阈值以下留出余量，避免下一轮立刻再次触发。
			// 注意括号：先算比例再乘上限。写成 Math.max(1, a - b) * limit 会让目标等于整个上限。
			const targetTokens = Math.max(0, threshold - TARGET_MARGIN) * limit;
			const needTokens = Math.max(0, lastInputTokens - targetTokens);
			// 用真实 inputTokens 标定密度：低估密度只会让我们多删一点，方向是安全的。
			const charsPerToken = lastMessageChars > 0
				? clamp(lastMessageChars / lastInputTokens, 1.5, 6)
				: FALLBACK_CHARS_PER_TOKEN;
			const needChars = needTokens * charsPerToken;

			const refs = collectToolResults(list);
			const targets = selectSlimTargets({
				refs,
				messageCount: list.length,
				keepMessages,
				minUnitChars: DEFAULT_MIN_UNIT_CHARS,
				needChars,
				minYieldChars,
				alreadySlimmed: new Set(slimmed.keys()),
			});
			if (targets.length === 0) return applySlimmed(list);

			let freedChars = 0;
			let stored = 0;
			let firstPath = '';
			for (const target of targets) {
				const file = spillText({
					cwd: cmd.cwd,
					sessionKey,
					group: GROUP,
					name: `${target.toolUseId}.txt`,
					text: target.text,
				});
				// 落盘失败就不动这一条：没有回溯路径的归档等于删数据。
				if (!file) continue;
				slimmed.set(target.toolUseId, {path: file.abs, chars: target.chars});
				freedChars += target.chars;
				stored += 1;
				firstPath ||= file.abs;
			}
			if (stored === 0) return list;

			// 记下这次动手所依据的 usage 水平，避免同一水平被反复处理。
			lastActedAtTokens = lastInputTokens;

			cmd.ui.notify(
				`上下文已达 ${(ratio * 100).toFixed(0)}%，已归档 ${stored} 条旧工具结果` +
					`（释放约 ${freedChars} 字符）。\n` +
					`完整内容已保存（模型也能按需 read_file 读回），例如：${firstPath}\n` +
					'（CLI 从 50% 起做不可恢复的裁剪，这里提前用可恢复的方式处理。）',
			);
			return applySlimmed(list);
		},
	});
}
