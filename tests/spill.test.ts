import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {sanitizeKey, shortHash, spillText, TEMP_DIR} from '../mods/lib/spill';

const created: string[] = [];

function tempRoot(): string {
	const dir = mkdtempSync(join(tmpdir(), 'cmdc-enhance-'));
	created.push(dir);
	return dir;
}

afterEach(() => {
	while (created.length > 0) rmSync(created.pop() as string, {recursive: true, force: true});
});

describe('sanitizeKey', () => {
	it('保留安全字符', () => {
		expect(sanitizeKey('abc-1_2.3', 'fb')).toBe('abc-1_2.3');
	});

	it('空格与特殊字符折成短横', () => {
		expect(sanitizeKey('My Session 1!', 'fb')).toBe('My-Session-1');
	});

	it('路径分隔符折成短横，无法穿透目录', () => {
		expect(sanitizeKey('a/b\\c', 'fb')).toBe('a-b-c');
	});

	it('`.` 与 `..` 一律回落，防止跳出目录', () => {
		expect(sanitizeKey('.', 'fb')).toBe('fb');
		expect(sanitizeKey('..', 'fb')).toBe('fb');
		expect(sanitizeKey('../..', 'fb')).toBe('fb');
	});

	it('空值回落', () => {
		expect(sanitizeKey('', 'fb')).toBe('fb');
		expect(sanitizeKey(undefined, 'fb')).toBe('fb');
		expect(sanitizeKey('   ', 'fb')).toBe('fb');
	});

	it('超长截到 64', () => {
		expect(sanitizeKey('a'.repeat(200), 'fb')).toHaveLength(64);
	});
});

describe('shortHash', () => {
	it('稳定且是 8 位十六进制', () => {
		expect(shortHash('hello')).toBe(shortHash('hello'));
		expect(shortHash('hello')).toMatch(/^[0-9a-f]{8}$/);
	});

	it('不同输入给出不同指纹', () => {
		expect(shortHash('a')).not.toBe(shortHash('b'));
	});

	it('空串也不炸', () => {
		expect(shortHash('')).toMatch(/^[0-9a-f]{8}$/);
	});
});

describe('spillText', () => {
	it('写到项目内 .commandcode/temp/<session>/<group>/ 下', () => {
		const cwd = tempRoot();
		const file = spillText({cwd, sessionKey: 'sess-1', group: 'tool-output', name: 't1.txt', text: 'hi'});
		expect(file).toBeDefined();
		expect(file?.rel).toBe(`${TEMP_DIR}/sess-1/tool-output/t1.txt`);
		expect(file?.abs).toBe(join(cwd, TEMP_DIR, 'sess-1', 'tool-output', 't1.txt'));
		expect(readFileSync(file?.abs as string, 'utf8')).toBe('hi');
	});

	it('内容按 UTF-8 落盘，中文不变形', () => {
		const cwd = tempRoot();
		const file = spillText({
			cwd,
			sessionKey: 's',
			group: 'pasted',
			name: 'p.md',
			text: '中文内容 · ok',
		});
		expect(readFileSync(file?.abs as string, 'utf8')).toBe('中文内容 · ok');
	});

	it('目录不存在时自动创建', () => {
		const cwd = tempRoot();
		expect(spillText({cwd, sessionKey: 'a', group: 'b', name: 'c.txt', text: 'x'})).toBeDefined();
	});

	it('不同会话互不覆盖（同一个文件名也安全）', () => {
		const cwd = tempRoot();
		const first = spillText({cwd, sessionKey: 's1', group: 'g', name: 't.txt', text: 'one'});
		const second = spillText({cwd, sessionKey: 's2', group: 'g', name: 't.txt', text: 'two'});
		expect(first?.abs).not.toBe(second?.abs);
		expect(readFileSync(first?.abs as string, 'utf8')).toBe('one');
		expect(readFileSync(second?.abs as string, 'utf8')).toBe('two');
	});

	it('会话键非法字符被净化后仍可用', () => {
		const cwd = tempRoot();
		const file = spillText({cwd, sessionKey: 'a/b:c', group: 'g', name: 't.txt', text: 'x'});
		expect(file?.rel).toBe(`${TEMP_DIR}/a-b-c/g/t.txt`);
	});

	it('写不进去时返回 undefined（调用方据此 fail-open）', () => {
		const cwd = tempRoot();
		const notADir = join(cwd, 'file.txt');
		writeFileSync(notADir, 'x');
		expect(spillText({cwd: notADir, sessionKey: 's', group: 'g', name: 't.txt', text: 'y'})).toBeUndefined();
	});

	it('返回的绝对路径落在 cwd 内', () => {
		const cwd = tempRoot();
		const file = spillText({cwd, sessionKey: 's', group: 'g', name: 't.txt', text: 'x'});
		expect(file?.abs.startsWith(cwd)).toBe(true);
	});
});
