import {existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {FOLD_MARKER_TAG} from '../mods/lib/text';
import outputFoldMod from '../mods/output-fold';

interface Call {
	readonly toolCallId: string;
	readonly toolName: string;
	readonly input: Record<string, unknown>;
	readonly result: unknown;
	readonly isError: boolean;
	readonly state: unknown;
}

type HookResult = {content?: unknown} | undefined;

const created: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), 'cmdc-fold-'));
	created.push(dir);
	return dir;
}

afterEach(() => {
	while (created.length > 0) rmSync(created.pop() as string, {recursive: true, force: true});
});

/** 最小 ModApi 桩：留下 afterToolCall 与 run_start，并允许手动发起一次调用。 */
function fakeCmd(options: {flags?: Record<string, string | boolean>; cwd: string}) {
	let after: ((call: Call) => HookResult) | undefined;
	const handlers = new Map<string, ((event: Record<string, unknown>) => void)[]>();
	return {
		cwd: options.cwd,
		addFlag: () => ({dispose: () => {}}),
		getFlag: (name: string) => options.flags?.[name],
		ui: {setStatus: () => {}, notify: () => {}},
		on: (event: string, handler: (event: Record<string, unknown>) => void) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			return {dispose: () => {}};
		},
		hooks: (hooks: {afterToolCall?: (call: Call) => HookResult}) => {
			after = hooks.afterToolCall;
			return {dispose: () => {}};
		},
		emit: (event: string, payload: Record<string, unknown> = {}) => {
			for (const handler of handlers.get(event) ?? []) handler({type: event, ...payload});
		},
		registered: () => after !== undefined,
		call: (result: unknown, toolName = 'shell_command', toolCallId = 't1'): HookResult =>
			after?.({toolCallId, toolName, input: {}, result, isError: false, state: {}}),
	};
}

const BIG = 'line of output\n'.repeat(2000);

function pathFrom(content: string): string {
	const match = /完整输出已保存到 (.+)/.exec(content);
	expect(match, '折叠提示里必须带落盘路径').not.toBeNull();
	return (match as RegExpExecArray)[1].trim();
}

describe('outputFoldMod 的触发判定', () => {
	it('小结果原样放行', () => {
		const cmd = fakeCmd({cwd: tempDir()});
		outputFoldMod(cmd as never);
		expect(cmd.call('tiny output')).toBeUndefined();
	});

	it('超长结果被折叠', () => {
		const cmd = fakeCmd({cwd: tempDir()});
		outputFoldMod(cmd as never);
		const result = cmd.call(BIG);
		expect(result?.content).toBeTypeOf('string');
		expect((result?.content as string).length).toBeLessThan(BIG.length);
		expect(result?.content as string).toContain(FOLD_MARKER_TAG);
	});

	it('阈值可由 flag 调小', () => {
		const cmd = fakeCmd({cwd: tempDir(), flags: {outputFoldLimit: '100'}});
		outputFoldMod(cmd as never);
		expect(cmd.call('a'.repeat(200))).toBeDefined();
	});

	it('阈值非法时回落默认值，小结果仍不动', () => {
		const cmd = fakeCmd({cwd: tempDir(), flags: {outputFoldLimit: 'abc'}});
		outputFoldMod(cmd as never);
		expect(cmd.call('a'.repeat(200))).toBeUndefined();
	});

	it('outputFold=false 时不折叠（开关在运行时判定）', () => {
		const cmd = fakeCmd({cwd: tempDir(), flags: {outputFold: false}});
		outputFoldMod(cmd as never);
		expect(cmd.call(BIG)).toBeUndefined();
	});

	it('字符串形式的 "false" 同样能关掉', () => {
		const cmd = fakeCmd({cwd: tempDir(), flags: {outputFold: 'false'}});
		outputFoldMod(cmd as never);
		expect(cmd.call(BIG)).toBeUndefined();
	});

	it('开关必须在运行时读：factory 阶段读不到 --mod-option 的值', () => {
		// 记录 factory 执行期间读到的 flag 值
		const seen: (boolean | string | undefined)[] = [];
		const cmd = fakeCmd({cwd: tempDir(), flags: {outputFold: false}});
		const originalGetFlag = cmd.getFlag;
		cmd.getFlag = (name: string) => {
			seen.push(originalGetFlag(name));
			return originalGetFlag(name);
		};
		outputFoldMod(cmd as never);
		// factory 期间不应有任何读取——若在此处读，会读到 default 而误判为开启
		expect(seen).toEqual([]);
		// 但 hook 一跑就必须读到真实值
		expect(cmd.call(BIG)).toBeUndefined();
	});

	it('形状不认识的结果放行', () => {
		const cmd = fakeCmd({cwd: tempDir()});
		outputFoldMod(cmd as never);
		expect(cmd.call({content: BIG})).toBeUndefined();
	});
});

describe('outputFoldMod 的排除名单', () => {
	it('默认不折 edit_file 这类确认性结果', () => {
		const cmd = fakeCmd({cwd: tempDir()});
		outputFoldMod(cmd as never);
		expect(cmd.call(BIG, 'edit_file')).toBeUndefined();
		expect(cmd.call(BIG, 'write_file')).toBeUndefined();
		expect(cmd.call(BIG, 'todo_write')).toBeUndefined();
	});

	it('read_file 与 shell_command 照折', () => {
		const cmd = fakeCmd({cwd: tempDir()});
		outputFoldMod(cmd as never);
		expect(cmd.call(BIG, 'read_file')).toBeDefined();
		expect(cmd.call(BIG, 'shell_command')).toBeDefined();
	});

	it('把名单传成空串就完全不过滤', () => {
		const cmd = fakeCmd({cwd: tempDir(), flags: {outputFoldSkip: ''}});
		outputFoldMod(cmd as never);
		expect(cmd.call(BIG, 'edit_file')).toBeDefined();
	});

	it('自定义名单生效', () => {
		const cmd = fakeCmd({cwd: tempDir(), flags: {outputFoldSkip: 'read_file, grep'}});
		outputFoldMod(cmd as never);
		expect(cmd.call(BIG, 'read_file')).toBeUndefined();
		expect(cmd.call(BIG, 'grep')).toBeUndefined();
		expect(cmd.call(BIG, 'shell_command')).toBeDefined();
	});
});

describe('outputFoldMod 的落盘与回溯', () => {
	it('全文写到提示里的路径，内容一字不差', () => {
		const cwd = tempDir();
		const cmd = fakeCmd({cwd});
		outputFoldMod(cmd as never);
		const content = cmd.call(BIG)?.content as string;
		const path = pathFrom(content);
		expect(existsSync(path)).toBe(true);
		expect(readFileSync(path, 'utf8')).toBe(BIG);
		expect(path.startsWith(cwd)).toBe(true);
	});

	it('落盘目录按会话分桶', () => {
		const cmd = fakeCmd({cwd: tempDir()});
		outputFoldMod(cmd as never);
		cmd.emit('run_start', {sessionId: 'sess-a'});
		expect(pathFrom(cmd.call(BIG)?.content as string)).toContain('sess-a');
	});

	it('换会话后落到另一个目录，不会互相覆盖', () => {
		const cmd = fakeCmd({cwd: tempDir()});
		outputFoldMod(cmd as never);
		cmd.emit('run_start', {sessionId: 'sess-a'});
		const first = pathFrom(cmd.call(BIG, 'shell_command', 'same-id')?.content as string);
		cmd.emit('run_start', {sessionId: 'sess-b'});
		const second = pathFrom(cmd.call(BIG, 'shell_command', 'same-id')?.content as string);
		expect(first).not.toBe(second);
		expect(readFileSync(first, 'utf8')).toBe(BIG);
		expect(readFileSync(second, 'utf8')).toBe(BIG);
	});

	it('拿不到 sessionId 时落到兜底目录，不炸', () => {
		const cmd = fakeCmd({cwd: tempDir()});
		outputFoldMod(cmd as never);
		expect(pathFrom(cmd.call(BIG)?.content as string)).toContain('session');
	});

	it('落盘失败就不折叠（宁可不省，也不能丢内容）', () => {
		const root = tempDir();
		const notADir = join(root, 'blocker.txt');
		writeFileSync(notADir, 'x');
		const cmd = fakeCmd({cwd: notADir});
		outputFoldMod(cmd as never);
		expect(cmd.call(BIG)).toBeUndefined();
	});
});

describe('outputFoldMod 的块形状处理', () => {
	it('数组结果只折最大的 text 块，图片块原样保留', () => {
		const image = {type: 'image', source: {data: 'zzz'}};
		const small = {type: 'text', text: 'short note'};
		const cmd = fakeCmd({cwd: tempDir()});
		outputFoldMod(cmd as never);
		const content = cmd.call([image, small, {type: 'text', text: BIG}])?.content as unknown[];
		expect(Array.isArray(content)).toBe(true);
		expect(content[0]).toBe(image);
		expect(content[1]).toBe(small);
		expect((content[2] as {text: string}).text).toContain(FOLD_MARKER_TAG);
	});

	it('只有图片块时放行', () => {
		const cmd = fakeCmd({cwd: tempDir()});
		outputFoldMod(cmd as never);
		expect(cmd.call([{type: 'image', source: {}}])).toBeUndefined();
	});
});

describe('outputFoldMod 的幂等性', () => {
	it('已带折叠标记的结果不再折一次', () => {
		const cmd = fakeCmd({cwd: tempDir()});
		outputFoldMod(cmd as never);
		expect(cmd.call(`${BIG}${FOLD_MARKER_TAG}`)).toBeUndefined();
	});
});
