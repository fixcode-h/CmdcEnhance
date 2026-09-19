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
	const percent = `${Math.round(info.hitRate * 100)}%`;
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

	const override = (): number | undefined => asPositiveNumber(Number(cmd.getFlag('contextWindow')));

	/**
	 * 会话累计口径。只在**本会话真有过**缓存活动时出现：完全不支持 prompt 缓存的
	 * provider 两项恒为 0，硬画一个 `cache 0%` 只是噪音。
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
		const text = renderStatus({
			used,
			limit: resolved.limit,
			estimated: resolved.source === 'default',
			columns: process.stdout.columns ?? 0,
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

	cmd.on('model_request_start', event => {
		if (typeof event.model === 'string' && event.model) model = event.model;
		paint();
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
		paint();
	});

	cmd.on('subagent_start', () => {
		subagentDepth += 1;
	});

	cmd.on('subagent_stop', () => {
		subagentDepth = Math.max(0, subagentDepth - 1);
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
		stopTicker();
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
