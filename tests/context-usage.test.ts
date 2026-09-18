import {describe, expect, it} from 'vitest';
import {
	DEFAULT_CONTEXT_LIMIT,
	expandModelKeys,
	parseCatalogLimits,
	parseConfigModel,
	parseProviderLimits,
	resolveLimit,
} from '../mods/lib/model-catalog';
import {
	barWidthFor,
	buildBar,
	formatDuration,
	formatTokens,
	renderStatus,
} from '../mods/context-usage';

const RED = '\u001b[31m';
const YELLOW = '\u001b[33m';
const GREEN = '\u001b[32m';

describe('formatTokens', () => {
	it('把非正数与非法值当 0', () => {
		expect(formatTokens(0)).toBe('0');
		expect(formatTokens(-1)).toBe('0');
		expect(formatTokens(Number.NaN)).toBe('0');
		expect(formatTokens(Number.POSITIVE_INFINITY)).toBe('0');
	});

	it('千以下取整、不带单位', () => {
		expect(formatTokens(1)).toBe('1');
		expect(formatTokens(999)).toBe('999');
	});

	it('千级保留一位小数并去尾零', () => {
		expect(formatTokens(1000)).toBe('1k');
		expect(formatTokens(1500)).toBe('1.5k');
		expect(formatTokens(20_000)).toBe('20k');
		expect(formatTokens(200_000)).toBe('200k');
	});

	it('百万级保留两位小数并去尾零', () => {
		expect(formatTokens(1_000_000)).toBe('1M');
		expect(formatTokens(1_500_000)).toBe('1.5M');
		expect(formatTokens(2_000_000)).toBe('2M');
	});

	// 现状行为：999999 落在千级分支，四舍五入后进位成 1000k 而不是 1M。
	it('千级上限附近不做跨级进位', () => {
		expect(formatTokens(999_999)).toBe('1000k');
	});
});

describe('formatDuration', () => {
	it('不足一分钟按秒', () => {
		expect(formatDuration(0)).toBe('0s');
		expect(formatDuration(999)).toBe('0s');
		expect(formatDuration(45_000)).toBe('45s');
		expect(formatDuration(59_999)).toBe('59s');
	});

	it('不足一小时按分钟，舍去秒', () => {
		expect(formatDuration(60_000)).toBe('1m');
		expect(formatDuration(3 * 60_000 + 30_000)).toBe('3m');
		expect(formatDuration(59 * 60_000)).toBe('59m');
	});

	it('不足一天按小时带分钟', () => {
		expect(formatDuration(60 * 60_000)).toBe('1h');
		expect(formatDuration(2 * 3_600_000 + 5 * 60_000)).toBe('2h5m');
	});

	it('超过一天按天带小时', () => {
		expect(formatDuration(24 * 3_600_000)).toBe('1d');
		expect(formatDuration(25 * 3_600_000)).toBe('1d1h');
	});

	it('负数与非法值当 0', () => {
		expect(formatDuration(-1)).toBe('0s');
		expect(formatDuration(Number.NaN)).toBe('0s');
		expect(formatDuration(Number.POSITIVE_INFINITY)).toBe('0s');
	});
});

describe('barWidthFor', () => {
	it('按终端宽度挑档', () => {
		expect(barWidthFor(200)).toBe(26);
		expect(barWidthFor(140)).toBe(26);
		expect(barWidthFor(139)).toBe(20);
		expect(barWidthFor(110)).toBe(20);
		expect(barWidthFor(109)).toBe(14);
		expect(barWidthFor(80)).toBe(14);
		expect(barWidthFor(79)).toBe(8);
	});

	it('宽度未知时用默认档', () => {
		expect(barWidthFor(0)).toBe(16);
		expect(barWidthFor(-1)).toBe(16);
		expect(barWidthFor(Number.NaN)).toBe(16);
	});
});

describe('buildBar', () => {
	it('按比例画填充块', () => {
		expect(buildBar(0, 4)).toBe('░░░░');
		expect(buildBar(0.5, 4)).toBe('██░░');
		expect(buildBar(1, 4)).toBe('████');
	});

	it('向下取整，不满一格不填', () => {
		expect(buildBar(0.24, 4)).toBe('░░░░');
		expect(buildBar(0.25, 4)).toBe('█░░░');
	});

	it('越界与非法比例被夹到 [0,1]', () => {
		expect(buildBar(-1, 4)).toBe('░░░░');
		expect(buildBar(2, 4)).toBe('████');
		expect(buildBar(Number.NaN, 4)).toBe('░░░░');
	});
});

describe('renderStatus', () => {
	it('渲染百分比与已用/上限', () => {
		const text = renderStatus({used: 50_000, limit: 100_000, estimated: false, columns: 120});
		expect(text).toContain('50%');
		expect(text).toContain('50k/100k');
	});

	it('上限是兜底估算时加 ~ 前缀', () => {
		const text = renderStatus({used: 1000, limit: 200_000, estimated: true, columns: 120});
		expect(text).toContain('1k/~200k');
	});

	it('按占用比例变色：绿 / 黄 / 红', () => {
		const at = (ratio: number): string =>
			renderStatus({used: ratio * 100_000, limit: 100_000, estimated: false, columns: 120});
		expect(at(0.1)).toContain(GREEN);
		expect(at(0.6)).toContain(YELLOW);
		expect(at(0.85)).toContain(RED);
	});

	it('上限为 0 时不除零', () => {
		const text = renderStatus({used: 100, limit: 0, estimated: false, columns: 120});
		expect(text).toContain('0%');
	});

	it('有压缩信息时追加到末尾', () => {
		const text = renderStatus({
			used: 50_000,
			limit: 100_000,
			estimated: false,
			columns: 120,
			compaction: {ageMs: 3 * 60_000, saved: 30_000},
		});
		expect(text).toContain('50k/100k');
		expect(text.indexOf('50k/100k')).toBeLessThan(text.indexOf('⟳'));
		expect(text).toContain('⟳ 3m -30k');
	});

	it('压缩没省下 token 时只显示时长', () => {
		const text = renderStatus({
			used: 1000,
			limit: 200_000,
			estimated: true,
			columns: 120,
			compaction: {ageMs: 5000, saved: 0},
		});
		expect(text).toContain('⟳ 5s');
		expect(text).not.toContain('-');
	});

	it('没有压缩信息时不追加', () => {
		const text = renderStatus({used: 1000, limit: 200_000, estimated: true, columns: 120});
		expect(text).not.toContain('⟳');
	});
});

describe('renderStatus 的缓存段', () => {
	const base = {used: 50_000, limit: 100_000, estimated: false, columns: 120};

	it('把会话累计命中率显示成百分比', () => {
		const text = renderStatus({...base, cache: {hitRate: 0.98, written: 0}});
		expect(text).toContain('cache 98%');
	});

	it('四舍五入到整数百分比', () => {
		expect(renderStatus({...base, cache: {hitRate: 0.485, written: 0}})).toContain('cache 49%');
		expect(renderStatus({...base, cache: {hitRate: 0.484, written: 0}})).toContain('cache 48%');
	});

	it('有缓存写入时附上写入量', () => {
		const text = renderStatus({...base, cache: {hitRate: 0.48, written: 12_000}});
		expect(text).toContain('cache 48% +12k');
	});

	it('写入量为 0 时不带 + 后缀', () => {
		const text = renderStatus({...base, cache: {hitRate: 0.98, written: 0}});
		expect(text).toContain('cache 98%');
		expect(text).not.toContain('+');
	});

	it('命中率为 0 也照样显示', () => {
		const text = renderStatus({...base, cache: {hitRate: 0, written: 5000}});
		expect(text).toContain('cache 0% +5k');
	});

	it('没有缓存信息时不追加', () => {
		const text = renderStatus(base);
		expect(text).not.toContain('cache');
	});

	it('cache 段排在压缩段之前', () => {
		const text = renderStatus({
			...base,
			cache: {hitRate: 0.9, written: 0},
			compaction: {ageMs: 60_000, saved: 30_000},
		});
		expect(text.indexOf('cache')).toBeLessThan(text.indexOf('⟳'));
	});
});

describe('renderStatus 的会话累计段', () => {
	const base = {used: 50_000, limit: 100_000, estimated: false, columns: 120};

	it('用 ↑ 显示累计输入、↓ 显示累计输出', () => {
		const text = renderStatus({...base, session: {input: 1_200_000, output: 45_000}});
		expect(text).toContain('↑1.2M ↓45k');
	});

	it('复用 formatTokens 的量级规则', () => {
		expect(renderStatus({...base, session: {input: 800, output: 12}})).toContain('↑800 ↓12');
		expect(renderStatus({...base, session: {input: 20_000, output: 1500}})).toContain(
			'↑20k ↓1.5k',
		);
	});

	it('输出为 0 时也照常显示', () => {
		const text = renderStatus({...base, session: {input: 5000, output: 0}});
		expect(text).toContain('↑5k ↓0');
	});

	it('没有会话累计时不追加', () => {
		const text = renderStatus(base);
		expect(text).not.toContain('↑');
		expect(text).not.toContain('↓');
	});

	it('三段顺序为：会话累计 → 缓存 → 压缩', () => {
		const text = renderStatus({
			...base,
			session: {input: 1_200_000, output: 45_000},
			cache: {hitRate: 0.9, written: 0},
			compaction: {ageMs: 60_000, saved: 30_000},
		});
		expect(text.indexOf('↑')).toBeLessThan(text.indexOf('cache'));
		expect(text.indexOf('cache')).toBeLessThan(text.indexOf('⟳'));
	});

	it('排在 used/limit 之后，不干扰上下文占用读数', () => {
		const text = renderStatus({...base, session: {input: 1_200_000, output: 45_000}});
		expect(text.indexOf('50k/100k')).toBeLessThan(text.indexOf('↑'));
	});
});

describe('expandModelKeys', () => {
	it('去 :effort 后缀，完整 id 优先', () => {
		expect(expandModelKeys('claude-sonnet-4-5:high')).toEqual([
			'claude-sonnet-4-5:high',
			'claude-sonnet-4-5',
		]);
	});

	it('去 -YYYYMMDD 日期后缀', () => {
		expect(expandModelKeys('gpt-5-20251101')).toEqual(['gpt-5-20251101', 'gpt-5']);
	});

	it('带 provider 前缀时额外给出裸名', () => {
		expect(expandModelKeys('anthropic/claude-3')).toEqual([
			'anthropic/claude-3',
			'claude-3',
		]);
	});

	it('去空白并小写化', () => {
		expect(expandModelKeys('  MiXeD  ')).toEqual(['mixed']);
	});

	it('空串给空数组', () => {
		expect(expandModelKeys('')).toEqual([]);
	});
});

describe('resolveLimit', () => {
	const empty = new Map<string, number>();

	it('--mod-option 覆盖一切', () => {
		const resolved = resolveLimit({
			model: 'acme/mystery-1',
			override: 32_000,
			providerLimits: new Map([['acme/mystery-1', 1000]]),
			catalogLimits: empty,
		});
		expect(resolved).toEqual({limit: 32_000, source: 'option'});
	});

	it('override 非正数等于没给', () => {
		const resolved = resolveLimit({
			model: 'acme/mystery-1',
			override: 0,
			providerLimits: new Map([['acme/mystery-1', 32_000]]),
			catalogLimits: empty,
		});
		expect(resolved).toEqual({limit: 32_000, source: 'provider'});
	});

	it('providers.json 优先于目录', () => {
		const resolved = resolveLimit({
			model: 'claude-x',
			providerLimits: new Map([['claude-x', 111_000]]),
			catalogLimits: new Map([['claude-x', 222_000]]),
		});
		expect(resolved).toEqual({limit: 111_000, source: 'provider'});
	});

	it('裸名模型可以命中目录', () => {
		const resolved = resolveLimit({
			model: 'claude-x',
			providerLimits: empty,
			catalogLimits: new Map([['claude-x', 500_000]]),
		});
		expect(resolved).toEqual({limit: 500_000, source: 'catalog'});
	});

	it('带前缀的 id 不认目录里的裸名（避免撞名谎报）', () => {
		const resolved = resolveLimit({
			model: 'acme/mystery-1',
			providerLimits: empty,
			catalogLimits: new Map([['mystery-1', 500_000]]),
		});
		expect(resolved).toEqual({limit: DEFAULT_CONTEXT_LIMIT, source: 'default'});
	});

	it('带前缀的 id 认目录里的全名', () => {
		const resolved = resolveLimit({
			model: 'acme/mystery-1',
			providerLimits: empty,
			catalogLimits: new Map([['acme/mystery-1', 400_000]]),
		});
		expect(resolved).toEqual({limit: 400_000, source: 'catalog'});
	});

	it('都查不到就回落到兜底值', () => {
		const resolved = resolveLimit({
			model: 'nobody-knows',
			providerLimits: empty,
			catalogLimits: empty,
		});
		expect(resolved).toEqual({limit: 200_000, source: 'default'});
	});
});

describe('parseCatalogLimits', () => {
	it('读出 limit.context，并同时登记裸名', () => {
		const map = parseCatalogLimits({
			data: {
				anthropic: {models: {claude: {limit: {context: 200_000}}}},
				openrouter: {models: {'openrouter/llama': {limit: {context: 131_072}}}},
			},
		});
		expect(map.get('claude')).toBe(200_000);
		expect(map.get('openrouter/llama')).toBe(131_072);
		expect(map.get('llama')).toBe(131_072);
	});

	it('忽略缺失、非数与非正的 context', () => {
		const map = parseCatalogLimits({
			data: {
				p: {
					models: {
						a: {},
						b: {limit: {}},
						c: {limit: {context: 'x'}},
						d: {limit: {context: 0}},
						e: {limit: {context: -1}},
					},
				},
			},
		});
		expect([...map.keys()]).toEqual([]);
	});

	it('空输入给空表', () => {
		expect(parseCatalogLimits(undefined).size).toBe(0);
	});
});

describe('parseProviderLimits', () => {
	it('同时登记裸名与 provider 前缀全名，且不覆盖已有键', () => {
		const map = parseProviderLimits({
			provider: {
				acme: {
					models: {
						'mystery-1': {contextWindow: 32_000},
						'other': null,
						'via-limit': {limit: {context: 64_000}},
					},
				},
			},
		});
		expect(map.get('mystery-1')).toBe(32_000);
		expect(map.get('acme/mystery-1')).toBe(32_000);
		expect(map.get('other')).toBeUndefined();
		expect(map.get('via-limit')).toBe(64_000);
	});

	it('provider 与 providers 两个键都读', () => {
		const map = parseProviderLimits({
			providers: {beta: {models: {m: {contextWindow: 1000}}}},
		});
		expect(map.get('beta/m')).toBe(1000);
	});

	it('空输入给空表', () => {
		expect(parseProviderLimits(undefined).size).toBe(0);
	});
});

describe('parseConfigModel', () => {
	it('读出记住的模型名', () => {
		expect(parseConfigModel({model: 'fixcode/deepseek-flash'})).toBe('fixcode/deepseek-flash');
	});

	it('去掉首尾空白', () => {
		expect(parseConfigModel({model: '  acme/big  '})).toBe('acme/big');
	});

	it('缺失、非字符串与空串都给空字符串', () => {
		expect(parseConfigModel(undefined)).toBe('');
		expect(parseConfigModel({})).toBe('');
		expect(parseConfigModel({model: 42})).toBe('');
		expect(parseConfigModel({model: null})).toBe('');
		expect(parseConfigModel({model: ''})).toBe('');
	});
});
