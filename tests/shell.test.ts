import {describe, expect, it} from 'vitest';
import {wrapShellCommand} from '../mods/lib/shell';

const WIN = {windows: true};
const OTHER_OS = {windows: false};

describe('wrapShellCommand', () => {
	it('非 Windows 不改写', () => {
		expect(wrapShellCommand('ls -la', OTHER_OS)).toBeUndefined();
	});

	it('空命令与纯空白不改写', () => {
		expect(wrapShellCommand('', WIN)).toBeUndefined();
		expect(wrapShellCommand('   ', WIN)).toBeUndefined();
	});

	it('先切代码页，再套一层 cmd /c', () => {
		expect(wrapShellCommand('dir', WIN)).toBe('chcp 65001>nul & cmd /d /s /c "dir"');
	});

	it('命令原文一字不动（引号 / && / 管道 / 开关）', () => {
		const command = 'echo "a b" && dir /b *.json | findstr /i package';
		expect(wrapShellCommand(command, WIN)).toBe(`chcp 65001>nul & cmd /d /s /c "${command}"`);
	});

	it('已带前缀时幂等', () => {
		const once = wrapShellCommand('dir', WIN);
		expect(once).toBeDefined();
		expect(wrapShellCommand(once as string, WIN)).toBeUndefined();
	});

	it('前缀前有空白也认得出来', () => {
		expect(wrapShellCommand('  chcp 65001>nul & dir', WIN)).toBeUndefined();
	});

	it('命令自身的 chcp 不算前缀（位置不同仍包装）', () => {
		expect(wrapShellCommand('echo hi & chcp 437', WIN)).toContain('chcp 65001>nul & cmd /d /s /c');
	});
});
