import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import inputShortcutsMod, {DEFAULT_PASTE_LIMIT, PASTE_KEEP_CHARS} from '../mods/input-shortcuts';

interface TransformResult {
	readonly action: string;
	readonly text?: string;
}

type HookResult = TransformResult | undefined;

const created: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), 'cmdc-short-'));
	created.push(dir);
	return dir;
}

afterEach(() => {
	vi.restoreAllMocks();
	while (created.length > 0) rmSync(created.pop() as string, {recursive: true, force: true});
});

/** 最小 ModApi 桩：留下 transformInput，记录 notify。 */
function fakeCmd(options: {readonly cwd: string; readonly flags?: Record<string, string | boolean>}) {
	let transform: ((call: {text: string}) => HookResult) | undefined;
	const handlers = new Map<string, ((event: Record<string, unknown>) => void)[]>();
	const notifications: {message: string; level?: string}[] = [];
	return {
		cwd: options.cwd,
		addFlag: () => ({dispose: () => {}}),
		getFlag: (name: string) => options.flags?.[name],
		ui: {
			setStatus: () => {},
			notify: (message: string, level?: string) => void notifications.push({message, level}),
		},
		on: (event: string, handler: (event: Record<string, unknown>) => void) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			return {dispose: () => {}};
		},
		hooks: (hooks: {transformInput?: (call: {text: string}) => HookResult}) => {
			transform = hooks.transformInput;
			return {dispose: () => {}};
		},
		emit: (event: string, payload: Record<string, unknown> = {}) => {
			for (const handler of handlers.get(event) ?? []) handler({type: event, ...payload});
		},
		registered: () => transform !== undefined,
		input: (text: string) => transform?.({text}),
		notifications,
	};
}

// 必须超过默认阈值（8000 字符），否则走不到这条通路
const longText = `${Array.from(
	{length: 400},
	(_unused, index) => `2026-01-01 12:00:00 ERROR 日志行 ${index} 内容内容内容内容内容内容内容内容`,
).join('\n')}\n帮我定位错误`;

describe('inputShortcutsMod 的粘贴转文件通路', () => {
	it('超长输入改写成文件引用，并把原文落盘', () => {
		expect(longText.length).toBeGreaterThan(DEFAULT_PASTE_LIMIT);
		const cwd = tempDir();
		const cmd = fakeCmd({cwd});
		inputShortcutsMod(cmd as never);
		const result = cmd.input(longText);
		expect(result?.action).toBe('transform');
		const rewritten = result?.text as string;
		expect(rewritten.length).toBeLessThan(longText.length);
		const match = /完整内容保存在 (.+)/.exec(rewritten);
		expect(match).not.toBeNull();
		const path = (match as RegExpExecArray)[1].trim();
		expect(path.startsWith(cwd)).toBe(true);
		expect(path).toContain('pasted');
		expect(readFileSync(path, 'utf8')).toBe(longText);
	});

	it('改写后仍保留用户末尾的提问', () => {
		const cmd = fakeCmd({cwd: tempDir()});
		inputShortcutsMod(cmd as never);
		expect(cmd.input(longText)?.text).toContain('帮我定位错误');
	});

	it('没到阈值就原样放行，且不落盘、不通知', () => {
		const cmd = fakeCmd({cwd: tempDir()});
		inputShortcutsMod(cmd as never);
		expect(cmd.input('短输入')).toEqual({action: 'continue'});
		expect(cmd.notifications).toHaveLength(0);
	});

	it('阈值可由 flag 调低', () => {
		const cmd = fakeCmd({cwd: tempDir(), flags: {pasteFoldLimit: '1000'}});
		inputShortcutsMod(cmd as never);
		const text = 'a'.repeat(PASTE_KEEP_CHARS * 3);
		expect(cmd.input(text)?.action).toBe('transform');
	});

	it('超阈值但折不动（还没摘录预算长）时原样放行，不做无意义的转换', () => {
		const cmd = fakeCmd({cwd: tempDir(), flags: {pasteFoldLimit: '10'}});
		inputShortcutsMod(cmd as never);
		expect(cmd.input('a'.repeat(200))).toEqual({action: 'continue'});
	});

	it('落盘失败时原样发给模型（fail-open），且不误报通知', () => {
		const root = tempDir();
		const notADir = join(root, 'blocker.txt');
		writeFileSync(notADir, 'x');
		const cmd = fakeCmd({cwd: notADir});
		inputShortcutsMod(cmd as never);
		expect(cmd.input(longText)).toEqual({action: 'continue'});
		expect(cmd.notifications).toHaveLength(0);
	});

	it('换会话后落到不同目录', () => {
		const cmd = fakeCmd({cwd: tempDir()});
		inputShortcutsMod(cmd as never);
		cmd.emit('run_start', {sessionId: 'sess-a'});
		const first = /完整内容保存在 (.+)/.exec(cmd.input(longText)?.text as string)?.[1];
		cmd.emit('run_start', {sessionId: 'sess-b'});
		const second = /完整内容保存在 (.+)/.exec(cmd.input(longText)?.text as string)?.[1];
		expect(first).toContain('sess-a');
		expect(second).toContain('sess-b');
		expect(first).not.toBe(second);
	});
});

describe('inputShortcutsMod 的告知', () => {
	it('转换后 notify 一次，说明已转引用、内容没丢', () => {
		const cmd = fakeCmd({cwd: tempDir()});
		inputShortcutsMod(cmd as never);
		cmd.input(longText);
		expect(cmd.notifications).toHaveLength(1);
		const message = cmd.notifications[0].message;
		// 用户必须知道「你的输入被改写了」，否则他看到的和模型收到的不是一回事
		expect(message).toContain('文件引用');
		expect(message).toContain('没有丢失');
		// 通知里给出可查看的相对路径
		expect(message).toContain('pasted');
	});

	it('通知里带原始字符数', () => {
		const cmd = fakeCmd({cwd: tempDir()});
		inputShortcutsMod(cmd as never);
		cmd.input(longText);
		expect(cmd.notifications[0].message).toContain(String(longText.length));
	});
});

describe('inputShortcutsMod 的开关', () => {
	it('inputShortcuts=false 时超长输入也不转换（开关优先于阈值）', () => {
		const cmd = fakeCmd({cwd: tempDir(), flags: {inputShortcuts: false, pasteFoldLimit: '10'}});
		inputShortcutsMod(cmd as never);
		expect(cmd.input('a'.repeat(9999))).toEqual({action: 'continue'});
	});

	it('字符串形式的 "false" 同样能关掉', () => {
		const cmd = fakeCmd({cwd: tempDir(), flags: {inputShortcuts: 'false'}});
		inputShortcutsMod(cmd as never);
		expect(cmd.input(longText)?.action).toBe('continue');
	});

	it('必须注册 hook 但运行时判定：factory 阶段读不到 --mod-option 的值', () => {
		// 若在 factory 里读 flag，会拿到 default 而误判为开启，开关就形同虚设。
		const seen: (boolean | string | undefined)[] = [];
		const cmd = fakeCmd({cwd: tempDir(), flags: {inputShortcuts: false}});
		const originalGetFlag = cmd.getFlag;
		cmd.getFlag = (name: string) => {
			seen.push(originalGetFlag(name));
			return originalGetFlag(name);
		};
		inputShortcutsMod(cmd as never);
		expect(seen).toEqual([]);
		expect(cmd.input(longText)?.action).toBe('continue');
	});

	it('默认开启', () => {
		const cmd = fakeCmd({cwd: tempDir()});
		inputShortcutsMod(cmd as never);
		expect(cmd.registered()).toBe(true);
		expect(cmd.input(longText)?.action).toBe('transform');
	});
});

describe('inputShortcutsMod 不再接管 !cmd', () => {
	// CLI 原生已有 bash 模式（空输入框打单个 `!` 切换），本 mod 不再复刻。
	it('以 ! 开头的输入原样放行，交给 CLI 自己处理', () => {
		const cmd = fakeCmd({cwd: tempDir()});
		inputShortcutsMod(cmd as never);
		expect(cmd.input('!git status')).toEqual({action: 'continue'});
		expect(cmd.notifications).toHaveLength(0);
	});
});
