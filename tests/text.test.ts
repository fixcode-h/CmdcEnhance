import {describe, expect, it} from 'vitest';
import {clampChars, clampTailChars, foldText} from '../mods/lib/text';

const MARK = '|MARK|';
const marker = (): string => MARK;

describe('clampChars', () => {
	it('不超就原样返回', () => {
		expect(clampChars('abc', 5)).toBe('abc');
	});

	it('超了从头截断', () => {
		expect(clampChars('abcdef', 3)).toBe('abc');
	});

	it('上限非正数得空串', () => {
		expect(clampChars('abc', 0)).toBe('');
	});
});

describe('clampTailChars', () => {
	it('不超就原样返回', () => {
		expect(clampTailChars('abc', 5)).toBe('abc');
	});

	it('超了保留结尾（报错与汇总在尾部，不能被切掉）', () => {
		expect(clampTailChars('abcdef', 3)).toBe('def');
	});

	it('上限非正数得空串', () => {
		expect(clampTailChars('abc', 0)).toBe('');
	});
});

describe('foldText 的触发条件', () => {
	it('未超阈值不折叠，原文一字不动', () => {
		const text = 'small';
		const result = foldText(text, {maxChars: 100, headLines: 3, tailLines: 2, marker});
		expect(result).toEqual({folded: false, text, omittedLines: 0, omittedChars: 0});
	});

	it('正好等于阈值也不折叠', () => {
		const text = 'x'.repeat(100);
		expect(foldText(text, {maxChars: 100, headLines: 3, tailLines: 2, marker}).folded).toBe(false);
	});

	it('超一个字符就折叠', () => {
		const text = 'x'.repeat(101);
		expect(foldText(text, {maxChars: 100, headLines: 3, tailLines: 2, marker}).folded).toBe(true);
	});
});

describe('foldText 的行分支（行数够多时）', () => {
	// 10 行 × 20 字符
	const text = Array.from({length: 10}, (_unused, index) => `L${index}`.padEnd(20, 'x')).join('\n');
	const options = {maxChars: 100, headLines: 3, tailLines: 2, marker};

	it('保留头 3 行、尾 2 行，并算清省略量', () => {
		const result = foldText(text, options);
		expect(result.folded).toBe(true);
		expect(result.omittedLines).toBe(5); // 10 - 3 - 2
		expect(result.omittedChars).toBe(text.length - 60 - 40);
	});

	it('头尾内容真的取自原文两端', () => {
		const result = foldText(text, options);
		expect(result.text.startsWith(text.slice(0, 60))).toBe(true);
		expect(result.text.endsWith(text.slice(-40))).toBe(true);
	});

	it('中间插入了 marker', () => {
		expect(foldText(text, options).text).toContain(MARK);
	});

	it('头尾之和不超过阈值（折叠不会反而变大）', () => {
		const result = foldText(text, options);
		expect(result.text.length).toBeLessThanOrEqual(100 + MARK.length);
	});
});

describe('foldText 的字符分支（行数很少时）', () => {
	// 单行 500 字符：按行取头尾会取到同一段，必须走字符对半切
	const text = 'y'.repeat(500);

	it('单行超长时按字符切，且头尾不重叠', () => {
		const result = foldText(text, {maxChars: 100, headLines: 3, tailLines: 2, marker});
		expect(result.folded).toBe(true);
		expect(result.omittedChars).toBe(400); // 500 - 60 - 40
		expect(result.text.startsWith('y'.repeat(60))).toBe(true);
		expect(result.text.endsWith('y'.repeat(40))).toBe(true);
	});

	it('行数不足头尾配额时 omittedLines 记 0', () => {
		const result = foldText(text, {maxChars: 100, headLines: 3, tailLines: 2, marker});
		expect(result.omittedLines).toBe(0);
	});

	it('行数刚好等于头尾配额也走字符分支', () => {
		// 5 行 = headLines + tailLines，不满足「>」，所以不能再按行切
		const fiveLines = 'z'.repeat(200) + '\n' + 'z'.repeat(200);
		const result = foldText(fiveLines, {maxChars: 100, headLines: 3, tailLines: 2, marker});
		expect(result.folded).toBe(true);
		expect(result.text.startsWith(fiveLines.slice(0, 60))).toBe(true);
	});
});

describe('foldText 的 marker 回调', () => {
	it('把真实的省略量交给调用方', () => {
		const text = Array.from({length: 20}, () => 'q'.repeat(50)).join('\n');
		let seen: {omittedLines: number; omittedChars: number} | undefined;
		foldText(text, {
			maxChars: 100,
			headLines: 2,
			tailLines: 2,
			marker: info => {
				seen = info;
				return '[…]';
			},
		});
		expect(seen?.omittedLines).toBe(16);
		expect(seen?.omittedChars).toBeGreaterThan(0);
	});
});
