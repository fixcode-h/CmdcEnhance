import {describe, expect, it} from 'vitest';
import {FOLD_MARKER_TAG} from '../mods/lib/text';
import {buildPasteRewrite, shouldFoldPaste} from '../mods/input-shortcuts';

describe('shouldFoldPaste', () => {
	it('超过阈值才折叠', () => {
		expect(shouldFoldPaste('a'.repeat(101), 100)).toBe(true);
	});

	it('正好等于阈值不折叠', () => {
		expect(shouldFoldPaste('a'.repeat(100), 100)).toBe(false);
	});

	it('低于阈值不折', () => {
		expect(shouldFoldPaste('short', 100)).toBe(false);
	});
});

describe('buildPasteRewrite', () => {
	// 101 行：多行分支，末行是用户真正的提问
	const logs = Array.from({length: 100}, (_unused, index) => `2026-01-01 ERROR 第${index}行日志内容`).join('\n');
	const text = `${logs}\n请分析这个报错`;
	const path = 'E:\\proj\\.commandcode\\temp\\s\\pasted\\1234-abcd.md';

	it('内容不够长时返回 undefined（调用方据此放行）', () => {
		expect(buildPasteRewrite({text: 'short', path})).toBeUndefined();
	});

	it('改写后显著变短', () => {
		const rewritten = buildPasteRewrite({text, path}) as string;
		expect(rewritten.length).toBeLessThan(text.length);
	});

	it('给出绝对路径，且开头就要求先读文件', () => {
		const rewritten = buildPasteRewrite({text, path}) as string;
		expect(rewritten).toContain(path);
		expect(rewritten).toContain('先 read_file 读取该文件');
	});

	it('保留末行的用户提问（不能被折掉）', () => {
		expect(buildPasteRewrite({text, path}) as string).toContain('请分析这个报错');
	});

	it('保留开头的原文，让模型知道这是什么', () => {
		expect(buildPasteRewrite({text, path}) as string).toContain('第0行日志内容');
	});

	it('带幂等标记与省略量', () => {
		const rewritten = buildPasteRewrite({text, path}) as string;
		expect(rewritten).toContain(FOLD_MARKER_TAG);
		expect(rewritten).toContain('中间已省略');
	});

	it('单行超长（行数少）时不把内容重复两遍', () => {
		// 头尾按行取会取到同一段，foldText 的字符分支负责避免重叠
		const singleLine = `${'A'.repeat(5000)}${'B'.repeat(5000)}`;
		const rewritten = buildPasteRewrite({text: singleLine, path}) as string;
		expect(rewritten.length).toBeLessThan(3000);
		expect(rewritten).toContain('AAAA');
		expect(rewritten).toContain('BBBB');
	});
});
