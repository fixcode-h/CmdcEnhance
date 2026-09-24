// 在输入框下方显示上下文占用进度条。
//
// 两条来自 CLI 实现的硬约束（不是取舍）：
//  - 输入框附近唯一真正渲染的挂点是 ui.setStatus。ui.widget 目前是空壳，不渲染任何东西。
//  - 没有任何 API 能读到「当前模型」或「上下文上限」。模型只能从 model_request_* 事件里抓；
//    上限由 lib/model-catalog 解析：--mod-option → providers.json → models.dev 缓存 → 兜底 200k。
//    （context-slim 用同一个模块，两处必须得出同一个上限。）
//
// 占用口径 = inputTokens + outputTokens。CLI 的 inputTokens 已是整段 prompt 的总数
// （cacheReadTokens 只是它的子集明细，不能相加），outputTokens 下一轮会进入 prompt。
//
// 会话累计（↑/↓）是另一个维度的数：把每轮的 inputTokens/outputTokens 累加，
// 衡量「本会话一共处理了多少 token」，不是上下文长度——每轮都会把整段 prompt 重发一遍。

import type {ModApi} from '@commandcode/harness';
import {
	asPositiveNumber,
	loadCatalogLimits,
	loadConfigModel,
	loadProviderLimits,
	resolveLimit,
} from './lib/model-catalog';

const ANSI = {
	reset: '\u001b[0m',
	dim: '\u001b[2m',
	green: '\u001b[32m',
	yellow: '\u001b[33m',
	red: '\u001b[31m',
};

/**
 * 生成速率（tok/s）的最短统计窗口。低于它的商全是计时噪声。
 *
 * 事件里**没有**任何耗时字段（`model_request_end` 只带 model/usage/stopReason/effort），
 * 时间只能自己量；而 delta 是**成簇**投递的——实测一轮 477 个 delta 只落在 18 个不同
 * 时间戳上，簇内时间差为 0，除出来是 ∞。所以只按窗口平均值算，绝不算瞬时值。
 *
 * 它同时是**纯生成窗口**的下限：窗口短于此值就认为没量到真实生成过程，速率改用
 * 回退口径（请求总时长，见 `finishRequest`），而不是不出数。
 */
export const MIN_GEN_MS = 200;

/** 标定值的夹取区间：实测英文输出约 2.75 字符/token，中文会低到 1 附近。 */
export const MIN_CHARS_PER_TOKEN = 1;
export const MAX_CHARS_PER_TOKEN = 6;

/** 最近一次上下文压缩（自动或 /compact）的摘要。 */
export interface CompactionInfo {
	/** 距该次压缩过去的毫秒数。 */
	readonly ageMs: number;
	/** 该次压缩省下的 token 数；<=0 表示事件没带或没省下，不显示。 */
	readonly saved: number;
}

/**
 * 本会话累计的 prompt 缓存情况，每完成一次请求累加，`session_start` 清零。
 *
 * **为什么用累计而不是最近一次**（实测）：单次命中率从第 2 轮起就恒为 99~100%
 * ——每轮只是把上一轮的 prompt 再发一遍，本来就几乎全命中，这个数字没有信息量
 * （实测 5 轮：47.9% → 99.0% → 99.0% → 99.0% → 99.0%）。累计值才有意义，
 * 它把会话早期的冷启动代价摊进来，如实反映整体缓存健康度（同 5 轮：47.9% → 89.0%）。
 * 而且它与紧邻的 ↑/↓ 段同为会话累计，尺度一致。
 */
export interface CacheInfo {
	/** 累计缓存读取占累计输入的比例（0-1），即会话命中率。 */
	readonly hitRate: number;
	/** 累计写入缓存的 token；<=0 表示没写过，不显示。 */
	readonly written: number;
}

/**
 * 本会话累计的输入/输出 token，每完成一次请求累加，`session_start` 清零。
 * 注意 input 是把整段 prompt 重发一遍的总数（含缓存读写的部分），
 * 不是「本次上下文长度」——后者看 used。
 */
export interface SessionInfo {
	readonly input: number;
	readonly output: number;
}

export interface StatusInput {
	readonly used: number;
	readonly limit: number;
	/** 上限是猜的（兜底值），显示时加 ~ 前缀。 */
	readonly estimated: boolean;
	readonly columns: number;
	/** 有则追加到状态栏末尾。 */
	readonly compaction?: CompactionInfo;
	/** 有则追加到状态栏末尾。 */
	readonly cache?: CacheInfo;
	/** 有则追加到状态栏末尾。 */
	readonly session?: SessionInfo;
	/** 最近一轮的生成速率（tok/s）。取不到生成窗口时不显示。 */
	readonly speed?: number;
}

function trimZeros(value: number, digits: number): string {
	return value.toFixed(digits).replace(/\.?0+$/, '');
}

export function formatTokens(value: number): string {
	if (!Number.isFinite(value) || value <= 0) return '0';
	if (value >= 1_000_000) return `${trimZeros(value / 1_000_000, 2)}M`;
	if (value >= 1_000) return `${trimZeros(value / 1_000, 1)}k`;
	return String(Math.round(value));
}

/** 把毫秒数压成紧凑时长：45s / 3m / 2h5m / 1d3h。 */
export function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return '0s';
	const totalSeconds = Math.floor(ms / 1000);
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const totalMinutes = Math.floor(totalSeconds / 60);
	if (totalMinutes < 60) return `${totalMinutes}m`;
	const totalHours = Math.floor(totalMinutes / 60);
	if (totalHours < 24) {
		const minutes = totalMinutes % 60;
		return minutes > 0 ? `${totalHours}h${minutes}m` : `${totalHours}h`;
	}
	const days = Math.floor(totalHours / 24);
	const hours = totalHours % 24;
	return hours > 0 ? `${days}d${hours}h` : `${days}d`;
}

export function barWidthFor(columns: number): number {
	if (!Number.isFinite(columns) || columns <= 0) return 16;
	if (columns >= 140) return 26;
	if (columns >= 110) return 20;
	if (columns >= 80) return 14;
	return 8;
}

/** 把毫秒差换算成速率；窗口太短或输出为 0 时返回 undefined（宁可不显示也不报错数）。 */
export function computeSpeed(outputTokens: number, genMs: number): number | undefined {
	if (!Number.isFinite(outputTokens) || outputTokens <= 0) return undefined;
	if (!Number.isFinite(genMs) || genMs < MIN_GEN_MS) return undefined;
	return (outputTokens / genMs) * 1000;
}

/**
 * 用上一轮**真实**的 outputTokens ÷ 已收字符数标定「字符/token」，供本轮流式中估算。
 *
 * 为什么需要它：流式期间只数得到字符（delta 是文本增量），拿不到 token 数；而字符/token
 * 对语言极敏感（实测英文约 2.75，中文接近 1）。用同一会话上一轮的比例去推本轮，比拍一个
 * 固定估值可靠得多——实测某模型只有 0.9 字符/token，拿 3 去估会低估 3 倍以上。
 * 缺数据时返回 undefined，调用方据此**不做估算**，而不是退回到一个猜的估值。
 */
export function calibrateCharsPerToken(outputTokens: number, chars: number): number | undefined {
	if (!Number.isFinite(outputTokens) || outputTokens <= 0) return undefined;
	if (!Number.isFinite(chars) || chars <= 0) return undefined;
	const ratio = chars / outputTokens;
	if (!Number.isFinite(ratio) || ratio <= 0) return undefined;
	return Math.min(MAX_CHARS_PER_TOKEN, Math.max(MIN_CHARS_PER_TOKEN, ratio));
}

/** 把 tok/s 压成短标签：`376 tok/s` / `86 tok/s` / `1.2k tok/s`。 */
export function formatSpeed(speed: number): string {
	if (!Number.isFinite(speed) || speed <= 0) return '';
	if (speed >= 1000) return `${trimZeros(speed / 1000, 1)}k tok/s`;
	return `${Math.round(speed)} tok/s`;
}

function renderSpeed(speed: number): string {
	const text = formatSpeed(speed);
	return text ? ` ${ANSI.dim}· ${text}${ANSI.reset}` : '';
}

const FILL = '█';
const EMPTY = '░';

export function buildBar(ratio: number, width: number): string {
	const cells = Math.max(0, Math.floor(width));
	const clamped = Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0));
	const filled = Math.floor(clamped * cells);
	return FILL.repeat(filled) + EMPTY.repeat(cells - filled);
}

function severityColor(ratio: number): string {
	if (ratio >= 0.85) return ANSI.red;
	if (ratio >= 0.6) return ANSI.yellow;
	return ANSI.green;
}

function renderCompaction(info: CompactionInfo): string {
	const saved = info.saved > 0 ? ` -${formatTokens(info.saved)}` : '';
	return ` ${ANSI.dim}· ⟳ ${formatDuration(info.ageMs)}${saved}${ANSI.reset}`;
}

/** 会话累计的缓存命中率与写入量（两者都是整个对话的累计，与左边的 ↑/↓ 同尺度）。 */
function renderCache(info: CacheInfo): string {
	const percent = `${(info.hitRate * 100).toFixed(2)}%`;
	// 累计写入量：只在本会话真写过缓存时出现。
	const written = info.written > 0 ? ` +${formatTokens(info.written)}` : '';
	return ` ${ANSI.dim}· cache ${percent}${written}${ANSI.reset}`;
}

/** ↑ 输入 / ↓ 输出，都是本会话累计。 */
function renderSession(info: SessionInfo): string {
	return ` ${ANSI.dim}· ↑${formatTokens(info.input)} ↓${formatTokens(info.output)}${ANSI.reset}`;
}

export function renderStatus(input: StatusInput): string {
	const width = barWidthFor(input.columns);
	const ratio = input.limit > 0 ? input.used / input.limit : 0;
	const color = severityColor(ratio);
	const percent = `${Math.round(ratio * 100)}%`;
	const limitText = `${input.estimated ? '~' : ''}${formatTokens(input.limit)}`;
	const bar = buildBar(ratio, width);
	return (
		`${ANSI.dim}ctx${ANSI.reset} ` +
		`${bar}${ANSI.reset} ` +
		`${color}${percent}${ANSI.reset} ` +
		`${ANSI.dim}${formatTokens(input.used)}/${limitText}${ANSI.reset}` +
		(input.speed ? renderSpeed(input.speed) : '') +
		(input.session ? renderSession(input.session) : '') +
		(input.cache ? renderCache(input.cache) : '') +
		(input.compaction ? renderCompaction(input.compaction) : '')
	);
}

export default function contextUsageMod(cmd: ModApi): void {
	cmd.addFlag('contextWindow', {
		type: 'string',
		description: '上下文进度条使用的窗口大小（token 数）。用于目录里查不到的模型。',
	});

	// 首屏在第一次 model_request_start 之前，事件还给不出模型，先用 config.json 的兜底。
	let model = loadConfigModel();
	// 当前上下文长度（最近一轮请求的 input + output）。
	let used = 0;
	// 本会话累计（只算主上下文，不含子代理）。每轮请求都会把整段 prompt 重发一遍，
	// 所以 input 会随轮次快速增长——它衡量的是「一共处理了多少 token」，不是上下文长度。
	let sessionInput = 0;
	let sessionOutput = 0;
	// 缓存也按会话累计：单次命中率恒为 99% 没有信息量，累计才有（详见 CacheInfo 注释）。
	// input 已含 cacheRead / cacheWrite，所以它们是 input 的子集明细，不能相加。
	let sessionCacheRead = 0;
	let sessionCacheWrite = 0;
	// 子代理的请求也走 model_request_end；凭它更新会跳到子上下文长度，用深度计数挡掉。
	let subagentDepth = 0;
	let painted = '';
	// 上一次压缩的时间点与省下的 token；undefined 表示本会话还没压缩过。
	let compactionAt: number | undefined;
	let compactionSaved = 0;
	// 压缩后状态栏要显示「距现在多久」，靠这个定时器把时长刷出来。
	let ticker: ReturnType<typeof setInterval> | undefined;

	// —— 生成速率（tok/s）——
	// 事件不带耗时，时间只能自己量：本轮首个 delta 记生成窗口起点，请求结束出结果。
	/** 本轮请求发出的时间；0 表示没见过 start（例如只喂了 end 的桩）。回退口径的起点。 */
	let requestStartAt = 0;
	/** 本轮首个 delta 的时间；0 表示本轮还没开始吐字。 */
	let firstDeltaAt = 0;
	/** 本轮已收到的字符数（text + thinking，它们都是模型吐出来的 token）。 */
	let streamChars = 0;
	/** 当前是否处于流式生成中（决定要不要按秒重绘）。 */
	let streaming = false;
	/** 最近一次结算出的速率；用真实 outputTokens ÷ 真实生成窗口。 */
	let speed: number | undefined;
	/**
	 * 「字符/token」的标定值，由上一轮的真实数据算出；**首轮为 undefined**。
	 *
	 * 没有它就不做流式估算：初值只能靠猜，而实测同一模型可能偏离估值 3 倍以上
	 * （真机：471 字符 / 520 token，即 0.9 字符/token，而估值是 3），估算出来的
	 * 数字错得比没有更糟。宁可首轮只显示结束后的真实值。
	 */
	let calibrated: number | undefined;

	/** 记录一段文本增量：第一次出现时开窗口，之后累加字符数。 */
	const noteDelta = (delta: unknown): void => {
		if (typeof delta !== 'string' || !delta) return;
		if (firstDeltaAt === 0) firstDeltaAt = Date.now();
		streamChars += delta.length;
	};

	/**
	 * 本轮结束结算速率。
	 *
	 * 首选**纯生成**口径：真实 outputTokens ÷ (end − 首个 delta)。
	 * 但实测有的 provider/模型在**工具轮**把 delta 成簇压到请求末尾投递——探针实测
	 * `genWindow=3~6ms`（首个 delta 距请求结束仅 3~6ms）、而窗口外仍有 179 token 输出，
	 * 这种窗口全是计时噪声，`computeSpeed` 会挡掉它。此时回退到**请求总时长**口径
	 * （end − start）：它含 TTFT、数字偏小，但任何轮次都出得来数——工具轮在 cmdc 里
	 * 是常态，宁可用一个偏保守的值，也别让状态栏常驻没有速率。
	 */
	const finishRequest = (outputTokens: number, endedAt: number): void => {
		// 首选纯生成口径；它被挡掉时（窗口太短）才退回请求总时长。
		const measured =
			firstDeltaAt > 0 ? computeSpeed(outputTokens, endedAt - firstDeltaAt) : undefined;
		if (measured !== undefined) {
			speed = measured;
		} else if (requestStartAt > 0) {
			const fallback = computeSpeed(outputTokens, endedAt - requestStartAt);
			if (fallback !== undefined) speed = fallback;
		}
		// 标定只依赖字符数与 token 数，与窗口口径无关，两种情况下都要更新。
		if (firstDeltaAt > 0) {
			const ratio = calibrateCharsPerToken(outputTokens, streamChars);
			if (ratio !== undefined) calibrated = ratio;
		}
		streaming = false;
	};

	/**
	 * 当前要显示的速率。生成中且**有标定值**时按字符估算（随秒往前爬），否则用上一轮的结算值。
	 *
	 * 首轮没有标定值就不估算——初值只能靠猜，而实测同一模型可以偏离估值 3 倍以上
	 * （真机：471 字符 / 520 token，即 0.9 字符/token，估值是 3），估出来的数错得比没有更糟。
	 * 从第二轮起标定值来自上一轮真实数据，估算才可信。
	 */
	const liveSpeed = (): number | undefined => {
		if (streaming && firstDeltaAt > 0 && streamChars > 0 && calibrated !== undefined) {
			const estimate = computeSpeed(streamChars / calibrated, Date.now() - firstDeltaAt);
			if (estimate !== undefined) return estimate;
		}
		return speed;
	};

	const override = (): number | undefined => asPositiveNumber(Number(cmd.getFlag('contextWindow')));

	/**
	 * 会话累计口径。只在**本会话真有过**缓存活动时出现：完全不支持 prompt 缓存的
	 * provider 两项恒为 0，硬画一个 `cache 0.00%` 只是噪音。
	 */
	const cacheInfo = (): CacheInfo | undefined => {
		if (sessionInput <= 0) return undefined;
		if (sessionCacheRead <= 0 && sessionCacheWrite <= 0) return undefined;
		return {
			hitRate: Math.min(1, sessionCacheRead / sessionInput),
			written: sessionCacheWrite,
		};
	};

	/** 首次请求之前两个都是 0，画出来只是噪音，等有数了再出现。 */
	const sessionInfo = (): SessionInfo | undefined =>
		sessionInput > 0 || sessionOutput > 0
			? {input: sessionInput, output: sessionOutput}
			: undefined;

	const paint = (): void => {
		const resolved = resolveLimit({
			model,
			override: override(),
			providerLimits: loadProviderLimits(),
			catalogLimits: loadCatalogLimits(),
		});
		const cache = cacheInfo();
		const session = sessionInfo();
		const current = liveSpeed();
		const text = renderStatus({
			used,
			limit: resolved.limit,
			estimated: resolved.source === 'default',
			columns: process.stdout.columns ?? 0,
			...(current === undefined ? {} : {speed: current}),
			...(session ? {session} : {}),
			...(cache ? {cache} : {}),
			...(compactionAt === undefined
				? {}
				: {compaction: {ageMs: Date.now() - compactionAt, saved: compactionSaved}}),
		});
		// setStatus 对相同文本不重绘，这里再过一层省掉无谓的调用。
		if (text === painted) return;
		painted = text;
		cmd.ui.setStatus(text);
	};

	const startTicker = (): void => {
		if (ticker) return;
		ticker = setInterval(paint, 1000);
		ticker.unref?.();
	};

	const stopTicker = (): void => {
		if (!ticker) return;
		clearInterval(ticker);
		ticker = undefined;
	};

	// 流式期间速率的估算值会随时间往前爬，得按秒重绘才看得到；请求结束即停。
	// 不能挂在 delta 上重绘——实测一轮 477 个 delta，那会变成每秒几百次 setStatus。
	let streamTicker: ReturnType<typeof setInterval> | undefined;

	const startStreamTicker = (): void => {
		if (streamTicker) return;
		streamTicker = setInterval(paint, 1000);
		streamTicker.unref?.();
	};

	const stopStreamTicker = (): void => {
		if (!streamTicker) return;
		clearInterval(streamTicker);
		streamTicker = undefined;
	};

	/** 一轮开始的公共重置：本轮还没吐字，窗口与计数都归零。 */
	const beginRequest = (): void => {
		requestStartAt = 0;
		firstDeltaAt = 0;
		streamChars = 0;
		streaming = false;
	};

	cmd.on('model_request_start', event => {
		if (subagentDepth > 0) return;
		if (typeof event.model === 'string' && event.model) model = event.model;
		beginRequest();
		// 回退口径（请求总时长）的起点；纯生成口径的首个 delta 会在 text/thinking_delta 里补上。
		requestStartAt = Date.now();
		paint();
	});

	// 文本与思考增量都算：它们都是模型吐出来的输出 token。
	cmd.on('text_delta', event => {
		if (subagentDepth > 0) return;
		noteDelta(event.delta);
		if (!streaming && firstDeltaAt > 0) {
			streaming = true;
			startStreamTicker();
		}
	});

	cmd.on('thinking_delta', event => {
		if (subagentDepth > 0) return;
		noteDelta(event.delta);
		if (!streaming && firstDeltaAt > 0) {
			streaming = true;
			startStreamTicker();
		}
	});

	cmd.on('model_request_end', event => {
		if (subagentDepth > 0) return;
		if (typeof event.model === 'string' && event.model) model = event.model;
		const usage = event.usage;
		const input = usage?.inputTokens ?? 0;
		const output = usage?.outputTokens ?? 0;
		// 当前上下文长度 = 本轮 prompt 总数 + 本轮输出（下一轮它会进入 prompt）。
		used = input + output;
		// 会话累计。input 已含缓存读写的部分，所以缓存两项只作为明细单独累加，
		// 不能并进 input（否则重复计数）。
		sessionInput += input;
		sessionOutput += output;
		sessionCacheRead += usage?.cacheReadTokens ?? 0;
		sessionCacheWrite += usage?.cacheWriteTokens ?? 0;
		// 用真实的 outputTokens 与自测的生成窗口结算速率（事件本身不带耗时）。
		finishRequest(output, Date.now());
		stopStreamTicker();
		paint();
	});

	cmd.on('subagent_start', () => {
		subagentDepth += 1;
	});

	cmd.on('subagent_stop', () => {
		subagentDepth = Math.max(0, subagentDepth - 1);
	});

	// 请求中断（abort / 网络错误）时 model_request_end **不会**发出——它在 CLI 的显式
	// try 里，异常会直接 break 出循环。所以流式定时器必须在 run 结束时兜底停掉，
	// 否则它每秒钟继续重绘，而且估算会因为「字符不再增长、时间继续流逝」而越算越小。
	// 注意只停流式那个：压缩时长的 ticker 本就该跨 run 持续刷新「⟳ 3m」。
	cmd.on('run_end', () => {
		beginRequest();
		stopStreamTicker();
	});

	cmd.on('session_start', () => {
		used = 0;
		sessionInput = 0;
		sessionOutput = 0;
		sessionCacheRead = 0;
		sessionCacheWrite = 0;
		subagentDepth = 0;
		compactionAt = undefined;
		compactionSaved = 0;
		beginRequest();
		speed = undefined;
		calibrated = undefined;
		stopTicker();
		stopStreamTicker();
		paint();
	});

	// 记下这次压缩省了多少，并让状态栏按秒刷新「距现在多久」。
	// 事件只带省下的量（`tokensSaved`），**不带**压缩后的真实用量，所以这里先按它
	// 把占用扣下去——进度条立刻回落，不用干等下一轮请求。这是估算：下一轮
	// `model_request_end` 会带回真实用量并覆盖它。
	cmd.on('compaction_done', event => {
		compactionAt = Date.now();
		compactionSaved = typeof event.tokensSaved === 'number' ? event.tokensSaved : 0;
		if (compactionSaved > 0) used = Math.max(0, used - compactionSaved);
		startTicker();
		paint();
	});

	paint();
}
