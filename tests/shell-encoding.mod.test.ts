import {afterEach, describe, expect, it, vi} from 'vitest';
import shellEncodingMod from '../mods/shell-encoding';

type HookResult = {input?: Record<string, unknown>} | undefined;

interface CallInput {
	readonly toolCallId: string;
	readonly toolName: string;
	readonly input: Record<string, unknown>;
	readonly state: unknown;
}

/** 最小 ModApi 桩：留下 beforeToolCall，并允许手动发起一次调用。 */
function fakeCmd(flags: Record<string, string | boolean> = {}) {
	let before: ((call: CallInput) => HookResult) | undefined;
	return {
		ui: {setStatus: () => {}},
		addFlag: () => ({dispose: () => {}}),
		getFlag: (name: string) => flags[name],
		on: () => ({dispose: () => {}}),
		hooks: (hooks: {beforeToolCall?: (call: CallInput) => HookResult}) => {
			before = hooks.beforeToolCall;
			return {dispose: () => {}};
		},
		call: (input: Record<string, unknown>, toolName = 'shell_command'): HookResult =>
			before?.({toolCallId: 't1', toolName, input, state: {}}),
	};
}

function asWindows(): void {
	vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
}

describe('shellEncodingMod 接线', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('Windows 上改写 shell 命令的入参', () => {
		asWindows();
		const cmd = fakeCmd();
		shellEncodingMod(cmd as never);
		expect(cmd.call({command: 'dir'})?.input?.command).toBe(
			'chcp 65001>nul & cmd /d /s /c "dir"',
		);
	});

	it('与 PSModulePath 无关：存在时也仍按 cmd.exe 包装', () => {
		asWindows();
		const cmd = fakeCmd();
		shellEncodingMod(cmd as never);
		const previous = process.env.PSModulePath;
		process.env.PSModulePath = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules';
		try {
			expect(cmd.call({command: 'dir'})?.input?.command).toContain('cmd /d /s /c');
		} finally {
			if (previous === undefined) delete process.env.PSModulePath;
			else process.env.PSModulePath = previous;
		}
	});

	it('其它工具不碰', () => {
		asWindows();
		const cmd = fakeCmd();
		shellEncodingMod(cmd as never);
		expect(cmd.call({command: 'dir'}, 'read_file')).toBeUndefined();
	});

	it('没有 command 字段时不碰', () => {
		asWindows();
		const cmd = fakeCmd();
		shellEncodingMod(cmd as never);
		expect(cmd.call({path: 'a.txt'})).toBeUndefined();
	});

	it('command 不是字符串时不碰', () => {
		asWindows();
		const cmd = fakeCmd();
		shellEncodingMod(cmd as never);
		expect(cmd.call({command: ['dir']})).toBeUndefined();
	});

	it('--mod-option shellEncoding=false 时完全不改写', () => {
		asWindows();
		const cmd = fakeCmd({shellEncoding: false});
		shellEncodingMod(cmd as never);
		expect(cmd.call({command: 'dir'})).toBeUndefined();
	});

	it('非 Windows 平台不改写', () => {
		vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
		const cmd = fakeCmd();
		shellEncodingMod(cmd as never);
		expect(cmd.call({command: 'ls -la'})).toBeUndefined();
	});

	it('保留入参的其它字段，只换 command', () => {
		asWindows();
		const cmd = fakeCmd();
		shellEncodingMod(cmd as never);
		const result = cmd.call({command: 'dir', cwd: 'E:\\x', timeout: 1000});
		expect(result?.input).toMatchObject({cwd: 'E:\\x', timeout: 1000});
	});
});
