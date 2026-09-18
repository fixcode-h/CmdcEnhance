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

	it('压缩后在末尾追加时长与省下的 token', () => {
		vi.useFakeTimers();
		const cmd = fakeCmd();
		contextUsageMod(cmd as never);
		cmd.emit('model_request_end', {model: 'm', usage: {inputTokens: 50_000}});
		cmd.emit('compaction_done', {tokensSaved: 30_000});
		expect(cmd.last()).toContain('50k/');
		expect(cmd.last()).toContain('⟳ 0s -30k');
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
	it('按 cacheRead/inputTokens 显示命中率', () => {
		const cmd = fakeCmd();
		contextUsageMod(cmd as never);
		cmd.emit('model_request_end', {
			model: 'm',
			usage: {inputTokens: 20_000, cacheReadTokens: 18_000, outputTokens: 100},
		});
		expect(cmd.last()).toContain('cache 90%');
	});

	it('cacheWrite 有值时才附上写入量', () => {
		const cmd = fakeCmd();
		contextUsageMod(cmd as never);
		cmd.emit('model_request_end', {
			model: 'm',
			usage: {inputTokens: 10_000, cacheReadTokens: 4_000, cacheWriteTokens: 6_000},
		});
		expect(cmd.last()).toContain('cache 40% +6k');
	});

	it('完全没有缓存活动时不显示 cache 段', () => {
		const cmd = fakeCmd();
		contextUsageMod(cmd as never);
		cmd.emit('model_request_end', {model: 'm', usage: {inputTokens: 10_000, outputTokens: 5}});
		expect(cmd.last()).not.toContain('cache');
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
		expect(cmd.last()).toContain('cache 90%');
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
