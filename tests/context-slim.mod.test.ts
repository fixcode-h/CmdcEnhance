import {existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import contextSlimMod, {SLIM_MARKER_TAG} from '../mods/context-slim';

type TransformResult = readonly unknown[];

const created: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), 'cmdc-slim-'));
	created.push(dir);
	return dir;
}

afterEach(() => {
	while (created.length > 0) rmSync(created.pop() as string, {recursive: true, force: true});
});

function fakeCmd(options: {readonly cwd: string; readonly flags?: Record<string, string | boolean>}) {
	let transform: ((call: {messages: readonly unknown[]}) => TransformResult) | undefined;
	const handlers = new Map<string, ((event: Record<string, unknown>) => void)[]>();
	const notifications: string[] = [];
	return {
		cwd: options.cwd,
		addFlag: () => ({dispose: () => {}}),
		getFlag: (name: string) => options.flags?.[name],
		ui: {setStatus: () => {}, notify: (message: string) => void notifications.push(message)},
		on: (event: string, handler: (event: Record<string, unknown>) => void) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			return {dispose: () => {}};
		},
		hooks: (hooks: {transformContext?: (call: {messages: readonly unknown[]}) => TransformResult}) => {
			transform = hooks.transformContext;
			return {dispose: () => {}};
		},
		emit: (event: string, payload: Record<string, unknown> = {}) => {
			for (const handler of handlers.get(event) ?? []) handler({type: event, ...payload});
		},
		transform: (messages: readonly unknown[]) => transform?.({messages}) ?? messages,
		notifications,
	};
}

const BIG = 30_000;

function bigText(marker: string): string {
	return `${marker}${'x'.repeat(BIG - marker.length)}`;
}

/** 10 条消息：4 组 tool_use/tool_result，最后一条是用户输入。 */
function buildMessages(): unknown[] {
	const messages: unknown[] = [{role: 'user', content: [{type: 'text', text: '开始'}]}];
	for (let index = 1; index <= 4; index += 1) {
		messages.push({
			role: 'assistant',
			content: [{type: 'tool_use', id: `call_${index}`, name: 'shell_command', input: {}}],
		});
		messages.push({
			role: 'user',
			content: [
				{
					type: 'tool_result',
					tool_use_id: `call_${index}`,
					content: [{type: 'text', text: bigText(`OUT-${index}-`)}],
				},
			],
		});
	}
	messages.push({role: 'user', content: [{type: 'text', text: '接着做'}]});
	return messages;
}

function textOfBlock(message: unknown): string {
	const content = (message as {content?: unknown[]}).content ?? [];
	const block = content[0] as {content?: {text?: string}[]};
	return block?.content?.[0]?.text ?? '';
}

/** 让最后一次真实 usage 达标（上下文上限固定成 100k，便于计算）。 */
const LIMIT_FLAG = {contextWindow: '100000'};

describe('contextSlimMod 的触发判定', () => {
	it('未达阈值时原样返回（同一引用）', () => {
		const cmd = fakeCmd({cwd: tempDir(), flags: LIMIT_FLAG});
		contextSlimMod(cmd as never);
		const messages = buildMessages();
		// 30% < 45%
		cmd.emit('model_request_end', {usage: {inputTokens: 30_000}});
		expect(cmd.transform(messages)).toBe(messages);
		expect(cmd.notifications).toHaveLength(0);
	});

	it('达到阈值时归档旧工具结果', () => {
		const cmd = fakeCmd({cwd: tempDir(), flags: LIMIT_FLAG});
		contextSlimMod(cmd as never);
		cmd.emit('run_start', {sessionId: 's'});
		cmd.emit('model_request_end', {usage: {inputTokens: 50_000}});
		const messages = buildMessages();
		const result = cmd.transform(messages);
		expect(result).not.toBe(messages);
		expect(cmd.notifications.length).toBeGreaterThan(0);
	});

	it('没有真实 usage 时不动手（不靠估算决策）', () => {
		const cmd = fakeCmd({cwd: tempDir(), flags: LIMIT_FLAG});
		contextSlimMod(cmd as never);
		const messages = buildMessages();
		expect(cmd.transform(messages)).toBe(messages);
	});

	it('contextSlim=false 时完全不介入', () => {
		const cmd = fakeCmd({cwd: tempDir(), flags: {...LIMIT_FLAG, contextSlim: false}});
		contextSlimMod(cmd as never);
		cmd.emit('model_request_end', {usage: {inputTokens: 90_000}});
		const messages = buildMessages();
		expect(cmd.transform(messages)).toBe(messages);
		expect(cmd.notifications).toHaveLength(0);
	});
});

describe('contextSlimMod 的归档行为', () => {
	function slimmed(flags: Record<string, string | boolean> = LIMIT_FLAG, input = 50_000) {
		const cwd = tempDir();
		const cmd = fakeCmd({cwd, flags});
		contextSlimMod(cmd as never);
		cmd.emit('run_start', {sessionId: 'sess-1'});
		cmd.emit('model_request_end', {usage: {inputTokens: input}});
		return {cmd, result: cmd.transform(buildMessages())};
	}

	it('把旧工具结果换成带路径的占位符', () => {
		const {result} = slimmed();
		const text = textOfBlock((result as unknown[])[2]);
		expect(text).toContain(SLIM_MARKER_TAG);
		expect(text).toContain('read_file');
	});

	it('原文完整落盘，且占位符里的路径就是它', () => {
		const {result} = slimmed();
		const text = textOfBlock((result as unknown[])[2]);
		const path = /完整内容保存在 (.+)/.exec(text)?.[1]?.trim() as string;
		expect(path).toBeDefined();
		expect(existsSync(path)).toBe(true);
		expect(readFileSync(path, 'utf8')).toBe(bigText('OUT-1-'));
	});

	it('落盘在项目内、按会话分桶的 slimmed 目录', () => {
		const {cmd, result} = slimmed();
		const path = /完整内容保存在 (.+)/.exec(textOfBlock((result as unknown[])[2]))?.[1] as string;
		expect(path).toContain(cmd.cwd);
		expect(path).toContain('sess-1');
		expect(path).toContain('slimmed');
	});

	it('保留 tool_use / tool_result 的配对（不删块）', () => {
		const {result} = slimmed();
		const list = result as Record<string, unknown>[];
		expect(list).toHaveLength(10);
		const assistant = list[1].content as Record<string, unknown>[];
		expect(assistant[0].id).toBe('call_1');
		const block = (list[2].content as Record<string, unknown>[])[0];
		expect(block.tool_use_id).toBe('call_1');
		expect(block.type).toBe('tool_result');
	});

	it('最近的消息不被触碰', () => {
		const {result} = slimmed();
		// 下标 6 及以后（keepMessages=4）必须原样
		const list = result as Record<string, unknown>[];
		for (const index of [6, 7, 8, 9]) {
			const text = textOfBlock(list[index]);
			if (text) expect(text).not.toContain(SLIM_MARKER_TAG);
		}
	});

	it('通知里说明归档了几条、并给出可用路径', () => {
		const {cmd} = slimmed();
		expect(cmd.notifications).toHaveLength(1);
		const message = cmd.notifications[0];
		expect(message).toContain('归档');
		expect(message).toContain('slimmed');
	});
});

describe('contextSlimMod 的稳定性（缓存命中的前提）', () => {
	it('同样的输入重复调用给出逐字节相同的输出', () => {
		const cmd = fakeCmd({cwd: tempDir(), flags: LIMIT_FLAG});
		contextSlimMod(cmd as never);
		cmd.emit('run_start', {sessionId: 's'});
		cmd.emit('model_request_end', {usage: {inputTokens: 50_000}});
		const first = cmd.transform(buildMessages());
		const second = cmd.transform(buildMessages());
		expect(JSON.stringify(second)).toBe(JSON.stringify(first));
	});

	it('降到阈值以下后，仍然重新贴同样的替换（否则前缀回退、缓存全废）', () => {
		const cmd = fakeCmd({cwd: tempDir(), flags: LIMIT_FLAG});
		contextSlimMod(cmd as never);
		cmd.emit('run_start', {sessionId: 's'});
		cmd.emit('model_request_end', {usage: {inputTokens: 50_000}});
		const during = JSON.stringify(cmd.transform(buildMessages()));
		// 上下文降下来了（例如用户 /compact 之后）
		cmd.emit('model_request_end', {usage: {inputTokens: 20_000}});
		expect(JSON.stringify(cmd.transform(buildMessages()))).toBe(during);
	});

	it('已归档的消息在后续轮次里逐字节不变（缓存不会churn）', () => {
		const cmd = fakeCmd({cwd: tempDir(), flags: LIMIT_FLAG});
		contextSlimMod(cmd as never);
		cmd.emit('run_start', {sessionId: 's'});
		cmd.emit('model_request_end', {usage: {inputTokens: 50_000}});
		const first = cmd.transform(buildMessages()) as unknown[];
		const firstCall1 = textOfBlock(first[2]);
		const firstCall2 = textOfBlock(first[4]);
		expect(firstCall1).toContain(SLIM_MARKER_TAG);

		// 对话继续增长：新消息越过保护窗口时**可能**新增归档（一次性的边界代价），
		// 但**已经归档的那些必须逐字节不变**，否则每轮都会打爆前缀缓存。
		const grown = [
			...buildMessages(),
			{role: 'assistant', content: [{type: 'tool_use', id: 'call_5', name: 'x', input: {}}]},
			{
				role: 'user',
				content: [
					{type: 'tool_result', tool_use_id: 'call_5', content: [{type: 'text', text: bigText('OUT-5-')}]},
				],
			},
		];
		cmd.emit('model_request_end', {usage: {inputTokens: 55_000}});
		const second = cmd.transform(grown) as unknown[];
		expect(textOfBlock(second[2])).toBe(firstCall1);
		expect(textOfBlock(second[4])).toBe(firstCall2);
	});

	it('同一个 usage 水平下重复调用完全一致（守卫：同一水平只动手一次）', () => {
		const cmd = fakeCmd({cwd: tempDir(), flags: LIMIT_FLAG});
		contextSlimMod(cmd as never);
		cmd.emit('run_start', {sessionId: 's'});
		cmd.emit('model_request_end', {usage: {inputTokens: 55_000}});
		const grown = [
			...buildMessages(),
			{role: 'assistant', content: [{type: 'tool_use', id: 'call_5', name: 'x', input: {}}]},
			{
				role: 'user',
				content: [
					{type: 'tool_result', tool_use_id: 'call_5', content: [{type: 'text', text: bigText('OUT-5-')}]},
				],
			},
		];
		const first = cmd.transform(grown) as unknown[];
		// 没有新的 usage 事件：同一水平再来一次，绝不能再改前缀
		const second = cmd.transform(grown) as unknown[];
		expect(JSON.stringify(second)).toBe(JSON.stringify(first));
	});

	it('usage 又涨上来了才允许再次动手（说明上次释放得不够）', () => {
		const cmd = fakeCmd({cwd: tempDir(), flags: LIMIT_FLAG});
		contextSlimMod(cmd as never);
		cmd.emit('run_start', {sessionId: 's'});
		cmd.emit('model_request_end', {usage: {inputTokens: 50_000}});
		const first = cmd.transform(buildMessages()) as unknown[];
		const firstCount = first.length;
		// usage 涨了，且还有可归档的（第 3 组刚越过保护窗口）
		const grown = [
			...buildMessages(),
			{role: 'assistant', content: [{type: 'tool_use', id: 'call_5', name: 'x', input: {}}]},
			{
				role: 'user',
				content: [
					{type: 'tool_result', tool_use_id: 'call_5', content: [{type: 'text', text: bigText('OUT-5-')}]},
				],
			},
		];
		cmd.emit('model_request_end', {usage: {inputTokens: 70_000}});
		const second = cmd.transform(grown) as unknown[];
		expect(second.length).toBe(firstCount + 2);
	});

	it('不重复归档同一条', () => {
		const cmd = fakeCmd({cwd: tempDir(), flags: LIMIT_FLAG});
		contextSlimMod(cmd as never);
		cmd.emit('run_start', {sessionId: 's'});
		cmd.emit('model_request_end', {usage: {inputTokens: 50_000}});
		cmd.transform(buildMessages());
		const countAfterFirst = cmd.notifications.length;
		// 同一批消息再来一次：已经没有可归档的了
		cmd.transform(buildMessages());
		expect(cmd.notifications.length).toBe(countAfterFirst);
	});
});

describe('contextSlimMod 的边界情形', () => {
	it('落盘失败就不替换（没有回溯路径的归档等于删数据）', () => {
		const root = tempDir();
		const notADir = join(root, 'blocker.txt');
		writeFileSync(notADir, 'x');
		const cmd = fakeCmd({cwd: notADir, flags: LIMIT_FLAG});
		contextSlimMod(cmd as never);
		cmd.emit('run_start', {sessionId: 's'});
		cmd.emit('model_request_end', {usage: {inputTokens: 90_000}});
		const messages = buildMessages();
		expect(cmd.transform(messages)).toBe(messages);
		expect(cmd.notifications).toHaveLength(0);
	});

	it('释放量低于下限时不动手', () => {
		// minYield 拉到极大，任何单条都满足不了
		const cmd = fakeCmd({cwd: tempDir(), flags: {...LIMIT_FLAG, contextSlimMinYield: '999999999'}});
		contextSlimMod(cmd as never);
		cmd.emit('run_start', {sessionId: 's'});
		cmd.emit('model_request_end', {usage: {inputTokens: 90_000}});
		const messages = buildMessages();
		expect(cmd.transform(messages)).toBe(messages);
		expect(cmd.notifications).toHaveLength(0);
	});

	it('没有工具结果时不动手', () => {
		const cmd = fakeCmd({cwd: tempDir(), flags: LIMIT_FLAG});
		contextSlimMod(cmd as never);
		cmd.emit('model_request_end', {usage: {inputTokens: 90_000}});
		const messages = [{role: 'user', content: [{type: 'text', text: '只有文字'}]}];
		expect(cmd.transform(messages)).toBe(messages);
	});

	it('子代理的用量不参与决策', () => {
		const cmd = fakeCmd({cwd: tempDir(), flags: LIMIT_FLAG});
		contextSlimMod(cmd as never);
		cmd.emit('subagent_start');
		cmd.emit('model_request_end', {usage: {inputTokens: 90_000}});
		const messages = buildMessages();
		expect(cmd.transform(messages)).toBe(messages);
	});

	it('session_start 清空已归档状态', () => {
		const cmd = fakeCmd({cwd: tempDir(), flags: LIMIT_FLAG});
		contextSlimMod(cmd as never);
		cmd.emit('run_start', {sessionId: 's'});
		cmd.emit('model_request_end', {usage: {inputTokens: 50_000}});
		cmd.transform(buildMessages());
		cmd.emit('session_start');
		const messages = buildMessages();
		expect(cmd.transform(messages)).toBe(messages);
	});

	it('开关在运行时判定：factory 阶段不读 flag', () => {
		const seen: (boolean | string | undefined)[] = [];
		const cmd = fakeCmd({cwd: tempDir(), flags: LIMIT_FLAG});
		const originalGetFlag = cmd.getFlag;
		cmd.getFlag = (name: string) => {
			seen.push(originalGetFlag(name));
			return originalGetFlag(name);
		};
		contextSlimMod(cmd as never);
		expect(seen).toEqual([]);
	});
});
