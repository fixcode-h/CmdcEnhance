import {afterEach, describe, expect, it, vi} from 'vitest';
import contextUsageMod from '../mods/context-usage';

type Handler = (event: Record<string, unknown>) => void;

/** 最小 ModApi 桩：记录 setStatus 调用并允许手动触发事件。 */
function fakeCmd(flags: Record<string, string | boolean> = {}) {
	const handlers = new Map<string, Handler[]>();
	const frames: string[] = [];
	return {
		frames,
		ui: {setStatus: (text: string | null) => void frames.push(text ?? '')},
		addFlag: () => ({dispose: () => {}}),
		getFlag: (name: string) => flags[name],
		on: (event: string, handler: Handler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			return {dispose: () => {}};
		},
		emit: (event: string, payload: Record<string, unknown> = {}) => {
			for (const handler of handlers.get(event) ?? []) handler({type: event, ...payload});
		},
		last: () => frames.at(-1) ?? '',
	};
}

describe('contextUsageMod 接线', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it('挂载时先画一帧 0 占用', () => {
		const cmd = fakeCmd();
		contextUsageMod(cmd as never);
		expect(cmd.frames).toHaveLength(1);
		expect(cmd.last()).toContain('0%');
	});

	it('按 inputTokens + outputTokens 记占用', () => {
		const cmd = fakeCmd();
		contextUsageMod(cmd as never);
		cmd.emit('model_request_start', {model: 'claude-x'});
		cmd.emit('model_request_end', {
			model: 'claude-x',
			usage: {inputTokens: 40_000, cacheReadTokens: 30_000, outputTokens: 10_000},
		});
		expect(cmd.last()).toContain('50k/');
	});

	it('子代理的用量不覆盖主上下文', () => {
		const cmd = fakeCmd();
		contextUsageMod(cmd as never);
		cmd.emit('model_request_end', {model: 'm', usage: {inputTokens: 1000, outputTokens: 0}});
		cmd.emit('subagent_start');
		cmd.emit('model_request_end', {model: 'm', usage: {inputTokens: 999_999, outputTokens: 0}});
		expect(cmd.last()).toContain('1k/');
		cmd.emit('subagent_stop');
		cmd.emit('model_request_end', {model: 'm', usage: {inputTokens: 2000, outputTokens: 0}});
		expect(cmd.last()).toContain('2k/');
	});

	it('--mod-option contextWindow 覆盖上限，且不再加 ~ 前缀', () => {
		const cmd = fakeCmd({contextWindow: '500000'});
		contextUsageMod(cmd as never);
		cmd.emit('model_request_end', {model: 'who-knows', usage: {inputTokens: 50_000}});
		expect(cmd.last()).toContain('50k/500k');
		expect(cmd.last()).not.toContain('~');
	});

	// 注意：两次相同 usage 的 model_request_end 现在会画出不同文本（会话累计增长了），
	// 所以要验去重得用一个不改变状态的事件来重复触发。
	it('相同文本不重复调用 setStatus', () => {
		const cmd = fakeCmd();
		contextUsageMod(cmd as never);
		cmd.emit('model_request_end', {model: 'm', usage: {inputTokens: 5000}});
		cmd.emit('model_request_start', {model: 'm'});
		const before = cmd.frames.length;
		cmd.emit('model_request_start', {model: 'm'});
		expect(cmd.frames).toHaveLength(before);
	});

	it('压缩后立刻按省下的量回落占用，不等下一轮请求', () => {
		vi.useFakeTimers();
		const cmd = fakeCmd({contextWindow: '1000000'});
		contextUsageMod(cmd as never);
		cmd.emit('model_request_end', {model: 'm', usage: {inputTokens: 50_000}});
		expect(cmd.last()).toContain('50k/1M');
		// 事件只带 tokensSaved，占用先按 50k - 30k 回落。
		cmd.emit('compaction_done', {tokensSaved: 30_000});
		expect(cmd.last()).toContain('20k/1M');
		expect(cmd.last()).toContain('⟳ 0s -30k');
	});

	it('压缩后的估算是暂时的，下一轮请求用真实用量覆盖', () => {
		vi.useFakeTimers();
		const cmd = fakeCmd({contextWindow: '1000000'});
		contextUsageMod(cmd as never);
		cmd.emit('model_request_end', {model: 'm', usage: {inputTokens: 50_000}});
		cmd.emit('compaction_done', {tokensSaved: 30_000});
		expect(cmd.last()).toContain('20k/1M');
		cmd.emit('model_request_end', {model: 'm', usage: {inputTokens: 18_000}});
		expect(cmd.last()).toContain('18k/1M');
	});

	it('压缩事件没带 tokensSaved 时不动占用', () => {
		vi.useFakeTimers();
		const cmd = fakeCmd({contextWindow: '1000000'});
		contextUsageMod(cmd as never);
		cmd.emit('model_request_end', {model: 'm', usage: {inputTokens: 50_000}});
		cmd.emit('compaction_done');
		expect(cmd.last()).toContain('50k/1M');
	});

	it('压缩事件没带 tokensSaved 时只显示时长', () => {
		vi.useFakeTimers();
		const cmd = fakeCmd();
		contextUsageMod(cmd as never);
		cmd.emit('compaction_done');
		expect(cmd.last()).toContain('⟳ 0s');
		expect(cmd.last()).not.toContain('-30k');
	});

	it('时长随时间往前走', () => {
		vi.useFakeTimers();
		const cmd = fakeCmd();
		contextUsageMod(cmd as never);
		cmd.emit('compaction_done', {tokensSaved: 30_000});
		vi.advanceTimersByTime(65_000);
		expect(cmd.last()).toContain('⟳ 1m -30k');
	});

	it('session_start 清掉上一次压缩的摘要', () => {
		vi.useFakeTimers();
		const cmd = fakeCmd();
		contextUsageMod(cmd as never);
		cmd.emit('compaction_done', {tokensSaved: 30_000});
		expect(cmd.last()).toContain('⟳');
		cmd.emit('session_start');
		expect(cmd.last()).not.toContain('⟳');
	});

	it('session_start 重置用量与子代理深度', () => {
		const cmd = fakeCmd();
		contextUsageMod(cmd as never);
		cmd.emit('model_request_end', {model: 'm', usage: {inputTokens: 5000}});
		cmd.emit('subagent_start');
		cmd.emit('session_start');
		expect(cmd.last()).toContain('0%');
		cmd.emit('model_request_end', {model: 'm', usage: {inputTokens: 7000}});
		expect(cmd.last()).toContain('7k/');
	});
});

describe('contextUsageMod 的缓存段接线', () => {
	it('首次请求时累计命中率等于该次命中率', () => {
		const cmd = fakeCmd();
		contextUsageMod(cmd as never);
		cmd.emit('model_request_end', {
			model: 'm',
			usage: {inputTokens: 20_000, cacheReadTokens: 18_000, outputTokens: 100},
		});
		expect(cmd.last()).toContain('cache 90.00%');
	});

	it('命中率是会话累计，而不是最近一次', () => {
		const cmd = fakeCmd();
		contextUsageMod(cmd as never);
		// 第 1 轮命中 90%
		cmd.emit('model_request_end', {
			model: 'm',
			usage: {inputTokens: 20_000, cacheReadTokens: 18_000},
		});
		expect(cmd.last()).toContain('cache 90.00%');
		// 第 2 轮只命中 5%（缓存被打断）
		cmd.emit('model_request_end', {model: 'm', usage: {inputTokens: 20_000, cacheReadTokens: 1_000}});
		// 累计 = (18000 + 1000) / (20000 + 20000) = 47.5%，绝不能显示成单次的 5%
		expect(cmd.last()).toContain('cache 47.50%');
		expect(cmd.last()).not.toContain('cache 5.00%');
	});

	it('单次恒为 99% 时，累计仍能反映早期的冷启动代价（实测数据）', () => {
		// 真机观测：第 1 轮 47.9%，之后每轮单次都恒为 99%，单次数字毫无信息量。
		const cmd = fakeCmd();
		contextUsageMod(cmd as never);
		cmd.emit('model_request_end', {
			model: 'm',
			usage: {inputTokens: 17_907, cacheReadTokens: 8_576},
		});
		expect(cmd.last()).toContain('cache 47.89%');
		cmd.emit('model_request_end', {
			model: 'm',
			usage: {inputTokens: 18_223, cacheReadTokens: 18_048},
		});
		// 累计 = 26624 / 36130 = 73.69%（单次是 99%）
		expect(cmd.last()).toContain('cache 73.69%');
	});

	it('cacheWrite 有值时才附上写入量', () => {
		const cmd = fakeCmd();
		contextUsageMod(cmd as never);
		cmd.emit('model_request_end', {
			model: 'm',
			usage: {inputTokens: 10_000, cacheReadTokens: 4_000, cacheWriteTokens: 6_000},
		});
		expect(cmd.last()).toContain('cache 40.00% +6k');
	});

	it('写入量同样是累计', () => {
		const cmd = fakeCmd();
		contextUsageMod(cmd as never);
		cmd.emit('model_request_end', {
			model: 'm',
			usage: {inputTokens: 10_000, cacheReadTokens: 4_000, cacheWriteTokens: 6_000},
		});
		cmd.emit('model_request_end', {
			model: 'm',
			usage: {inputTokens: 10_000, cacheReadTokens: 6_000, cacheWriteTokens: 4_000},
		});
		// 累计写入 6k + 4k = 10k
		expect(cmd.last()).toContain('+10k');
	});

	it('本会话从未有过缓存活动时不显示 cache 段', () => {
		const cmd = fakeCmd();
		contextUsageMod(cmd as never);
		cmd.emit('model_request_end', {model: 'm', usage: {inputTokens: 10_000, outputTokens: 5}});
		expect(cmd.last()).not.toContain('cache');
	});

	it('某轮没有缓存活动，但本会话有过时仍显示累计值', () => {
		const cmd = fakeCmd();
		contextUsageMod(cmd as never);
		cmd.emit('model_request_end', {
			model: 'm',
			usage: {inputTokens: 10_000, cacheReadTokens: 9_000},
		});
		// 这一轮完全没有缓存活动
		cmd.emit('model_request_end', {model: 'm', usage: {inputTokens: 10_000}});
		// 累计仍是 9000/20000 = 45%
		expect(cmd.last()).toContain('cache 45.00%');
	});

	it('子代理请求里的缓存活动不覆盖主上下文', () => {
		const cmd = fakeCmd();
		contextUsageMod(cmd as never);
		cmd.emit('model_request_end', {
			model: 'm',
			usage: {inputTokens: 10_000, cacheReadTokens: 9_000},
		});
		cmd.emit('subagent_start');
		cmd.emit('model_request_end', {
			model: 'm',
			usage: {inputTokens: 100_000, cacheReadTokens: 1_000},
		});
		expect(cmd.last()).toContain('cache 90.00%');
	});

	it('session_start 清掉上一次会话的缓存信息', () => {
		const cmd = fakeCmd();
		contextUsageMod(cmd as never);
		cmd.emit('model_request_end', {
			model: 'm',
			usage: {inputTokens: 20_000, cacheReadTokens: 18_000},
		});
		expect(cmd.last()).toContain('cache');
		cmd.emit('session_start');
		expect(cmd.last()).not.toContain('cache');
	});

	it('session_start 后累计从零重新开始', () => {
		const cmd = fakeCmd();
		contextUsageMod(cmd as never);
		cmd.emit('model_request_end', {
			model: 'm',
			usage: {inputTokens: 20_000, cacheReadTokens: 2_000},
		});
		expect(cmd.last()).toContain('cache 10.00%');
		cmd.emit('session_start');
		cmd.emit('model_request_end', {
			model: 'm',
			usage: {inputTokens: 20_000, cacheReadTokens: 18_000},
		});
		// 若累计没清零，这里会是 (2000+18000)/(20000+20000) = 50%
		expect(cmd.last()).toContain('cache 90.00%');
	});

	it('缓存段排在压缩段之前', () => {
		const cmd = fakeCmd();
		contextUsageMod(cmd as never);
		cmd.emit('model_request_end', {
			model: 'm',
			usage: {inputTokens: 20_000, cacheReadTokens: 18_000},
		});
		cmd.emit('compaction_done', {tokensSaved: 30_000});
		expect(cmd.last().indexOf('cache')).toBeLessThan(cmd.last().indexOf('⟳'));
	});
});

describe('contextUsageMod 的会话累计接线', () => {
	it('首屏没有累计值时不显示 ↑/↓', () => {
		const cmd = fakeCmd();
		contextUsageMod(cmd as never);
		expect(cmd.last()).not.toContain('↑');
	});

	it('跨多轮请求累加输入与输出', () => {
		const cmd = fakeCmd();
		contextUsageMod(cmd as never);
		cmd.emit('model_request_end', {model: 'm', usage: {inputTokens: 17_000, outputTokens: 180}});
		cmd.emit('model_request_end', {model: 'm', usage: {inputTokens: 18_000, outputTokens: 100}});
		cmd.emit('model_request_end', {model: 'm', usage: {inputTokens: 19_000, outputTokens: 20}});
		expect(cmd.last()).toContain('↑54k ↓300');
	});

	it('累计输入包含缓存读取的部分（整段 prompt 重发）', () => {
		const cmd = fakeCmd();
		contextUsageMod(cmd as never);
		cmd.emit('model_request_end', {
			model: 'm',
			usage: {inputTokens: 18_000, cacheReadTokens: 17_000, outputTokens: 50},
		});
		expect(cmd.last()).toContain('↑18k ↓50');
	});

	it('累计与「当前上下文长度」是两个数，互不覆盖', () => {
		const cmd = fakeCmd();
		contextUsageMod(cmd as never);
		cmd.emit('model_request_end', {model: 'm', usage: {inputTokens: 20_000, outputTokens: 0}});
		cmd.emit('model_request_end', {model: 'm', usage: {inputTokens: 21_000, outputTokens: 0}});
		expect(cmd.last()).toContain('21k/'); // used 仍是最后一次的
		expect(cmd.last()).toContain('↑41k'); // 累计是两轮之和
	});

	it('子代理期间的请求不计入累计', () => {
		const cmd = fakeCmd();
		contextUsageMod(cmd as never);
		cmd.emit('model_request_end', {model: 'm', usage: {inputTokens: 10_000, outputTokens: 100}});
		cmd.emit('subagent_start');
		cmd.emit('model_request_end', {model: 'm', usage: {inputTokens: 90_000, outputTokens: 9000}});
		expect(cmd.last()).toContain('↑10k ↓100');
		cmd.emit('subagent_stop');
		cmd.emit('model_request_end', {model: 'm', usage: {inputTokens: 11_000, outputTokens: 50}});
		expect(cmd.last()).toContain('↑21k ↓150');
	});

	it('session_start 把累计清零', () => {
		const cmd = fakeCmd();
		contextUsageMod(cmd as never);
		cmd.emit('model_request_end', {model: 'm', usage: {inputTokens: 30_000, outputTokens: 500}});
		expect(cmd.last()).toContain('↑30k');
		cmd.emit('session_start');
		expect(cmd.last()).not.toContain('↑');
		cmd.emit('model_request_end', {model: 'm', usage: {inputTokens: 7000, outputTokens: 30}});
		expect(cmd.last()).toContain('↑7k ↓30');
	});

	it('缺 inputTokens 的事件按 0 计，不产生 NaN', () => {
		const cmd = fakeCmd();
		contextUsageMod(cmd as never);
		cmd.emit('model_request_end', {model: 'm', usage: {outputTokens: 40}});
		expect(cmd.last()).toContain('↑0 ↓40');
		expect(cmd.last()).not.toContain('NaN');
	});

	it('会话累计段排在缓存段之前', () => {
		const cmd = fakeCmd();
		contextUsageMod(cmd as never);
		cmd.emit('model_request_end', {
			model: 'm',
			usage: {inputTokens: 20_000, cacheReadTokens: 18_000, outputTokens: 100},
		});
		expect(cmd.last().indexOf('↑')).toBeLessThan(cmd.last().indexOf('cache'));
	});
});

describe('contextUsageMod 的速度段接线', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	// 事件不带耗时，速率只能靠 delta/end 的时间点自己量。
	// 用假定时器统一推进：vitest 的 fake timers 同时接管 Date，时间与定时器一起走，
	// 不会出现两个时钟漂移。
	function withClock() {
		vi.useFakeTimers();
		return {advance: (ms: number): void => void vi.advanceTimersByTime(ms)};
	}

	/** 跑一轮完整请求：开窗口、吐 chars 个字符、等 genMs、结算。 */
	function runRound(
		cmd: ReturnType<typeof fakeCmd>,
		options: {chars: number; genMs: number; outputTokens: number; thinking?: boolean},
	): void {
		cmd.emit('model_request_start', {model: 'm'});
		cmd.emit(options.thinking ? 'thinking_delta' : 'text_delta', {
			delta: 'a'.repeat(options.chars),
		});
		vi.advanceTimersByTime(options.genMs);
		cmd.emit('model_request_end', {
			model: 'm',
			usage: {inputTokens: 10_000, outputTokens: options.outputTokens},
		});
	}

	it('结算速率 = 真实 outputTokens ÷ 自测的生成窗口', () => {
		withClock();
		const cmd = fakeCmd();
		contextUsageMod(cmd as never);
		// 900 token / 1000ms = 900 tok/s
		runRound(cmd, {chars: 900, genMs: 1000, outputTokens: 900});
		expect(cmd.last()).toContain('900 tok/s');
	});

	it('首轮没有标定值，流式期间不估算（宁可暂不出数）', () => {
		withClock();
		const cmd = fakeCmd();
		contextUsageMod(cmd as never);
		cmd.emit('model_request_start', {model: 'm'});
		cmd.emit('text_delta', {delta: 'a'.repeat(600)});
		// 还没有任何历史可标定「字符/token」→ 不猜，暂不出数（哪怕已经收了不少字符）。
		vi.advanceTimersByTime(2000);
		expect(cmd.last()).not.toContain('tok/s');

		// 本轮结束：真实值照样出得来（250 token / 2000ms = 125 tok/s）。
		cmd.emit('model_request_end', {model: 'm', usage: {inputTokens: 10_000, outputTokens: 250}});
		expect(cmd.last()).toContain('125 tok/s');
	});

	// 真机教训：某模型实测 471 字符 / 520 token（0.9 字符/token），拿固定估值 3 去算
	// 会低估 3 倍以上（49 对 381）。所以标定必须来自上一轮的真实数据。
	it('第二轮起用上一轮标定值做实时估算', () => {
		const {advance} = withClock();
		const cmd = fakeCmd();
		contextUsageMod(cmd as never);
		// 第 1 轮：800 字符 / 800 token，窗口 1600ms → 标定 1 字符/token，结算 500 tok/s
		runRound(cmd, {chars: 800, genMs: 1600, outputTokens: 800});
		expect(cmd.last()).toContain('500 tok/s');

		// 第 2 轮：800 字符、窗口 1000ms → 按标定 1.0 估得 800 token / 1s = 800 tok/s
		cmd.emit('model_request_start', {model: 'm'});
		cmd.emit('text_delta', {delta: 'a'.repeat(800)});
		advance(1000);
		expect(cmd.last()).toContain('800 tok/s');
	});

	it('实时估算的窗口太短时，computeSpeed 会把它挡掉', () => {
		const {advance} = withClock();
		const cmd = fakeCmd();
		contextUsageMod(cmd as never);
		runRound(cmd, {chars: 1000, genMs: 2000, outputTokens: 1000});
		expect(cmd.last()).toContain('500 tok/s');

		// 第 2 轮刚开始吐字：窗口只有 50ms，估算会被 MIN_GEN_MS 挡掉，沿用上一轮的值。
		cmd.emit('model_request_start', {model: 'm'});
		cmd.emit('text_delta', {delta: 'a'.repeat(60)});
		advance(50);
		expect(cmd.last()).toContain('500 tok/s');
		expect(cmd.last()).not.toContain('NaN');
	});

	it('思考增量也算生成（它同样是模型吐出的 token）', () => {
		withClock();
		const cmd = fakeCmd();
		contextUsageMod(cmd as never);
		// 字符数只来自 thinking_delta，仍应正常标定并结算。
		runRound(cmd, {chars: 1000, genMs: 2000, outputTokens: 1000, thinking: true});
		expect(cmd.last()).toContain('500 tok/s');
	});

	it('本轮结束后速率保留，直到下一轮重置', () => {
		withClock();
		const cmd = fakeCmd();
		contextUsageMod(cmd as never);
		runRound(cmd, {chars: 900, genMs: 1000, outputTokens: 900});
		expect(cmd.last()).toContain('900 tok/s');
		cmd.emit('model_request_start', {model: 'm'});
		expect(cmd.last()).toContain('900 tok/s');
	});

	it('子代理的增量与请求都不影响主速率', () => {
		withClock();
		const cmd = fakeCmd();
		contextUsageMod(cmd as never);
		runRound(cmd, {chars: 900, genMs: 1000, outputTokens: 900});

		cmd.emit('subagent_start');
		cmd.emit('model_request_start', {model: 'm'});
		cmd.emit('text_delta', {delta: 'b'.repeat(9000)});
		vi.advanceTimersByTime(1000);
		cmd.emit('model_request_end', {
			model: 'm',
			usage: {inputTokens: 90_000, outputTokens: 9000},
		});
		cmd.emit('subagent_stop');
		expect(cmd.last()).toContain('900 tok/s');
	});

	it('缺 outputTokens 时不结算，也不产生 NaN', () => {
		withClock();
		const cmd = fakeCmd();
		contextUsageMod(cmd as never);
		cmd.emit('model_request_start', {model: 'm'});
		cmd.emit('text_delta', {delta: 'a'.repeat(900)});
		vi.advanceTimersByTime(1000);
		cmd.emit('model_request_end', {model: 'm', usage: {inputTokens: 10_000}});
		expect(cmd.last()).not.toContain('tok/s');
		expect(cmd.last()).not.toContain('NaN');
	});

	// 中断（abort / 网络错误）时 model_request_end 不会发出，流式定时器必须在 run_end 兜底停掉，
	// 否则它会一直重绘，且估算值随「字符不再增长、时间继续流逝」越算越小。
	it('run_end 兜底停掉流式刷新，估算值不再继续下滑', () => {
		const {advance} = withClock();
		const cmd = fakeCmd();
		contextUsageMod(cmd as never);
		// 先有一轮真实数据，建立标定值。
		runRound(cmd, {chars: 800, genMs: 1600, outputTokens: 800});

		// 第二轮开始流式，中途被中断：没有 model_request_end。
		cmd.emit('model_request_start', {model: 'm'});
		cmd.emit('text_delta', {delta: 'a'.repeat(800)});
		advance(1000);
		expect(cmd.last()).toContain('800 tok/s');
		cmd.emit('run_end');
		const afterRunEnd = cmd.frames.length;
		// 定时器已停：再推进 5 秒也不会产生新帧（否则估算会一路掉下去）。
		advance(5000);
		expect(cmd.frames).toHaveLength(afterRunEnd);
		expect(cmd.last()).toContain('800 tok/s');
	});

	it('session_start 清掉速率与标定值', () => {
		withClock();
		const cmd = fakeCmd();
		contextUsageMod(cmd as never);
		runRound(cmd, {chars: 900, genMs: 1000, outputTokens: 900});
		expect(cmd.last()).toContain('tok/s');
		cmd.emit('session_start');
		expect(cmd.last()).not.toContain('tok/s');

		// 标定也被清掉：新一轮流式期间不该出现估算值。
		cmd.emit('model_request_start', {model: 'm'});
		cmd.emit('text_delta', {delta: 'a'.repeat(900)});
		vi.advanceTimersByTime(2000);
		expect(cmd.last()).not.toContain('tok/s');
	});
});
