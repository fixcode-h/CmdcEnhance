// 在输入框下方显示上下文占用进度条。
//
// 两条来自 CLI 实现的硬约束（不是取舍）：
//  - 输入框附近唯一真正渲染的挂点是 ui.setStatus。ui.widget 目前是空壳，不渲染任何东西。
//  - 没有任何 API 能读到「当前模型」或「上下文上限」。模型只能从 model_request_* 事件里抓；
//    上限由本文件自己解析：--mod-option → providers.json → models.dev 缓存 → 兜底 200k。
//
// 占用口径 = inputTokens + outputTokens。CLI 的 inputTokens 已是整段 prompt 的总数
// （cacheReadTokens 只是它的子集明细，不能相加），outputTokens 下一轮会进入 prompt。
//
// 会话累计（↑/↓）是另一个维度的数：把每轮的 inputTokens/outputTokens 累加，
// 衡量「本会话一共处理了多少 token」，不是上下文长度——每轮都会把整段 prompt 重发一遍。

import {readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import type {ModApi} from '@commandcode/harness';

const CONFIG_DIR = join(homedir(), '.commandcode');
const CATALOG_PATH = join(CONFIG_DIR, 'cache', 'models-dev.json');
const PROVIDERS_PATH = join(CONFIG_DIR, 'providers.json');
const CONFIG_PATH = join(CONFIG_DIR, 'config.json');

/** 与 CLI 自身的兜底值一致（内部常量 xr）。 */
export const DEFAULT_CONTEXT_LIMIT = 200_000;

const ANSI = {
	reset: '\u001b[0m',
	dim: '\u001b[2m',
	green: '\u001b[32m',
	yellow: '\u001b[33m',
	red: '\u001b[31m',
};

export type LimitSource = 'option' | 'provider' | 'catalog' | 'default';

export interface LimitResolution {
	readonly limit: number;
	readonly source: LimitSource;
}

/** 最近一次上下文压缩（自动或 /compact）的摘要。 */
export interface CompactionInfo {
	/** 距该次压缩过去的毫秒数。 */
	readonly ageMs: number;
	/** 该次压缩省下的 token 数；<=0 表示事件没带或没省下，不显示。 */
	readonly saved: number;
}

/** 最近一次请求的 prompt 缓存情况。 */
export interface CacheInfo {
	/** 缓存读取占本次输入的比例（0-1），即命中率。 */
	readonly hitRate: number;
	/** 本次写入缓存的 token；<=0 表示没写，不显示。 */
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

function renderCache(info: CacheInfo): string {
	const percent = `${Math.round(info.hitRate * 100)}%`;
	// 写入量只在真有写入时出现；它和命中率是一对：高写入压低命中率，但会摊到后续轮次。
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

/**
 * 模型 id 的候选查表键，按优先级：完整 id 优先于裸名，避免跨 provider 撞名。
 * 对应 CLI 的 canonicalizeModelId：去 `:effort` 后缀、去 `-YYYYMMDD` 日期后缀。
 */
export function expandModelKeys(model: string): string[] {
	const keys: string[] = [];
	const add = (value: string | undefined): void => {
		if (!value) return;
		const key = value.trim().toLowerCase();
		if (key && !keys.includes(key)) keys.push(key);
	};
	const raw = model.trim();
	const forms = [raw, raw.replace(/[:#].*$/, '')];
	for (const form of forms) add(form);
	for (const form of forms) add(form.replace(/[-@]\d{8}$/, ''));
	for (const key of [...keys]) add(key.split('/').pop());
	return keys;
}

function asPositiveNumber(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

export function resolveLimit(input: {
	readonly model: string;
	readonly override?: number;
	readonly providerLimits: ReadonlyMap<string, number>;
	readonly catalogLimits: ReadonlyMap<string, number>;
}): LimitResolution {
	if (asPositiveNumber(input.override)) {
		return {limit: input.override as number, source: 'option'};
	}
	const keys = expandModelKeys(input.model);
	for (const key of keys) {
		const hit = input.providerLimits.get(key);
		if (hit) return {limit: hit, source: 'provider'};
	}
	// 目录里裸名会撞车：`acme/mystery-1` 的裸名 `mystery-1` 可能命中别家同名模型。
	// 带前缀的 id 只认全名匹配，查不到宁可回落到估算值，也不谎报一个别人的窗口。
	const allowBare = !input.model.includes('/');
	for (const key of keys) {
		if (!allowBare && !key.includes('/')) continue;
		const hit = input.catalogLimits.get(key);
		if (hit) return {limit: hit, source: 'catalog'};
	}
	return {limit: DEFAULT_CONTEXT_LIMIT, source: 'default'};
}

function readJson(path: string): unknown {
	try {
		return JSON.parse(readFileSync(path, 'utf8'));
	} catch {
		return undefined;
	}
}

function indexLimit(map: Map<string, number>, key: string, limit: number, bareAlso: boolean): void {
	const lower = key.trim().toLowerCase();
	if (!lower) return;
	if (!map.has(lower)) map.set(lower, limit);
	if (!bareAlso) return;
	const bare = lower.split('/').pop();
	if (bare && bare !== lower && !map.has(bare)) map.set(bare, limit);
}

export interface CatalogFile {
	readonly data?: Record<string, {models?: Record<string, {limit?: {context?: unknown}}>}>;
}

export interface ProvidersFile {
	readonly provider?: Record<string, ProviderEntry>;
	readonly providers?: Record<string, ProviderEntry>;
}

/** `~/.commandcode/config.json` 里记住的上次使用的模型。 */
export interface ConfigFile {
	readonly model?: unknown;
}

interface ProviderEntry {
	readonly models?: Record<string, {contextWindow?: unknown; limit?: {context?: unknown}} | null>;
}

export function parseCatalogLimits(root: CatalogFile | undefined): Map<string, number> {
	const out = new Map<string, number>();
	for (const provider of Object.values(root?.data ?? {})) {
		for (const [modelId, model] of Object.entries(provider?.models ?? {})) {
			const limit = asPositiveNumber(model?.limit?.context);
			if (limit) indexLimit(out, modelId, limit, true);
		}
	}
	return out;
}

/** BYOK 自定义 provider 在 providers.json 里声明的 contextWindow（或 limit.context）。 */
export function parseProviderLimits(root: ProvidersFile | undefined): Map<string, number> {
	const out = new Map<string, number>();
	for (const group of ['provider', 'providers'] as const) {
		for (const [providerId, provider] of Object.entries(root?.[group] ?? {})) {
			for (const [modelId, entry] of Object.entries(provider?.models ?? {})) {
				const limit =
					asPositiveNumber(entry?.contextWindow) ?? asPositiveNumber(entry?.limit?.context);
				if (!limit) continue;
				indexLimit(out, modelId, limit, false);
				indexLimit(out, `${providerId}/${modelId}`, limit, false);
			}
		}
	}
	return out;
}

export function loadProviderLimits(): Map<string, number> {
	return parseProviderLimits(readJson(PROVIDERS_PATH) as ProvidersFile | undefined);
}

let catalogCache: Map<string, number> | undefined;

/** models.dev 目录缓存（4.7MB），首次查表时才解析。 */
export function loadCatalogLimits(): Map<string, number> {
	catalogCache ??= parseCatalogLimits(readJson(CATALOG_PATH) as CatalogFile | undefined);
	return catalogCache;
}

/**
 * config.json 里的模型名。CLI 启动到第一次 model_request_start 之间是事件静默期，
 * 这段时间只有这里能拿到模型，否则首屏必然落到兜底的 ~200k。
 */
export function parseConfigModel(root: ConfigFile | undefined): string {
	return typeof root?.model === 'string' ? root.model.trim() : '';
}

export function loadConfigModel(): string {
	return parseConfigModel(readJson(CONFIG_PATH) as ConfigFile | undefined);
}

export default function contextUsageMod(cmd: ModApi): void {
	cmd.addFlag('contextWindow', {
		type: 'string',
		description: '上下文进度条使用的窗口大小（token 数）。用于目录里查不到的模型。',
	});

	// 首屏在第一次 model_request_start 之前，事件还给不出模型，先用 config.json 的兜底。
	let model = loadConfigModel();
	let used = 0;
	// 最近一次请求的 prompt 构成：input 是总数，cacheRead / cacheWrite 都是它的子集。
	let promptTokens = 0;
	let cacheReadTokens = 0;
	let cacheWriteTokens = 0;
	// 本会话累计（只算主上下文，不含子代理）。每轮请求都会把整段 prompt 重发一遍，
	// 所以 input 会随轮次快速增长——它衡量的是「一共处理了多少 token」，不是上下文长度。
	let sessionInput = 0;
	let sessionOutput = 0;
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
	 * 缓存段只在这次请求真有缓存活动时出现：完全不支持 prompt 缓存的 provider
	 * 两项恒为 0，硬画一个 `cache 0%` 只是噪音。
	 */
	const cacheInfo = (): CacheInfo | undefined => {
		if (promptTokens <= 0) return undefined;
		if (cacheReadTokens <= 0 && cacheWriteTokens <= 0) return undefined;
		return {hitRate: Math.min(1, cacheReadTokens / promptTokens), written: cacheWriteTokens};
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
		promptTokens = usage?.inputTokens ?? 0;
		cacheReadTokens = usage?.cacheReadTokens ?? 0;
		cacheWriteTokens = usage?.cacheWriteTokens ?? 0;
		used = promptTokens + (usage?.outputTokens ?? 0);
		sessionInput += promptTokens;
		sessionOutput += usage?.outputTokens ?? 0;
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
		promptTokens = 0;
		cacheReadTokens = 0;
		cacheWriteTokens = 0;
		sessionInput = 0;
		sessionOutput = 0;
		subagentDepth = 0;
		compactionAt = undefined;
		compactionSaved = 0;
		stopTicker();
		paint();
	});

	// 记下这次压缩省了多少，并让状态栏按秒刷新「距现在多久」；
	// 压缩后下一轮请求会带回新的（更小的）用量。
	cmd.on('compaction_done', event => {
		compactionAt = Date.now();
		compactionSaved = typeof event.tokensSaved === 'number' ? event.tokensSaved : 0;
		startTicker();
		paint();
	});

	paint();
}
