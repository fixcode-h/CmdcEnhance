// 模型上下文的解析：模型 id 归一化、窗口上限查找、配置文件读取。
// context-usage（显示占用条）与 context-slim（超限前瘦身）共用同一套口径——
// 两处必须得出**同一个上限**，否则一个说 40% 一个说 90%，行为会自相矛盾。
//
// 三条来自 CLI 实现的硬约束（不是取舍）：
//  - 没有任何 API 能读到「当前模型」或「上下文上限」。模型只能从 model_request_* 事件里抓；
//    上限只能自己解析。
//  - 上限优先级：--mod-option → providers.json（BYOK 的 contextWindow）→ models.dev 目录 → 兜底。
//  - 目录里模型 id 会撞名，跨 provider 查表必须区分全名与裸名（见 resolveLimit）。

import {readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';

export const CONFIG_DIR = join(homedir(), '.commandcode');
export const CATALOG_PATH = join(CONFIG_DIR, 'cache', 'models-dev.json');
export const PROVIDERS_PATH = join(CONFIG_DIR, 'providers.json');
export const CONFIG_PATH = join(CONFIG_DIR, 'config.json');

/** 与 CLI 自身的兜底值一致。 */
export const DEFAULT_CONTEXT_LIMIT = 200_000;

export type LimitSource = 'option' | 'provider' | 'catalog' | 'default';

export interface LimitResolution {
	readonly limit: number;
	readonly source: LimitSource;
}

export function asPositiveNumber(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
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

export function readJson(path: string): unknown {
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
