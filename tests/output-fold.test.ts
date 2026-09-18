import {describe, expect, it} from 'vitest';
import {FOLD_MARKER_TAG} from '../mods/lib/text';
import {buildFoldMarker, findLargestText, mapLargestText} from '../mods/output-fold';

describe('findLargestText', () => {
	it('字符串结果直接就是目标', () => {
		expect(findLargestText('hello')).toEqual({text: 'hello', chars: 5});
	});

	it('块数组里挑最大的 text 块', () => {
		const result = [
			{type: 'text', text: 'small'},
			{type: 'text', text: 'the biggest one'},
			{type: 'text', text: 'mid'},
		];
		expect(findLargestText(result)).toEqual({text: 'the biggest one', chars: 15});
	});

	it('image 等非 text 块被忽略', () => {
		const result = [{type: 'image', source: {}}, {type: 'text', text: 'text only'}];
		expect(findLargestText(result)?.text).toBe('text only');
	});

	it('没有 text 块时返回 undefined', () => {
		expect(findLargestText([{type: 'image', source: {}}])).toBeUndefined();
		expect(findLargestText([])).toBeUndefined();
	});

	it('形状不认识时返回 undefined（fail-open 的依据）', () => {
		expect(findLargestText({content: 'x'})).toBeUndefined();
		expect(findLargestText(null)).toBeUndefined();
		expect(findLargestText(undefined)).toBeUndefined();
		expect(findLargestText(42)).toBeUndefined();
	});

	it('text 不是字符串的块不算数', () => {
		expect(findLargestText([{type: 'text', text: 123}])).toBeUndefined();
	});
});

describe('mapLargestText', () => {
	it('字符串结果整体替换', () => {
		expect(mapLargestText('abcdef', () => 'X')).toBe('X');
	});

	it('只换最大的那块，其它块原样保留', () => {
		const image = {type: 'image', source: {}};
		const small = {type: 'text', text: 'keep me'};
		const big = {type: 'text', text: 'replace me please'};
		const mapped = mapLargestText([image, small, big], () => 'FOLDED') as unknown[];
		expect(mapped[0]).toBe(image); // 引用不变
		expect(mapped[1]).toBe(small);
		expect(mapped[2]).toEqual({type: 'text', text: 'FOLDED'});
	});

	it('形状不认识时原样返回，不抛', () => {
		const weird = {content: 'x'};
		expect(mapLargestText(weird, () => 'X')).toBe(weird);
	});

	it('没有 text 块时原样返回', () => {
		const onlyImage = [{type: 'image'}];
		expect(mapLargestText(onlyImage, () => 'X')).toBe(onlyImage);
	});
});

describe('buildFoldMarker', () => {
	const marker = buildFoldMarker('E:\\proj\\.commandcode\\temp\\s\\tool-output\\t1.txt', {
		omittedLines: 12,
		omittedChars: 3456,
	});

	it('带幂等标记', () => {
		expect(marker).toContain(FOLD_MARKER_TAG);
	});

	it('报出省略的行数与字符数', () => {
		expect(marker).toContain('已省略 12 行');
		expect(marker).toContain('3456 字符');
	});

	it('单行超长（0 行）时不报「0 行」，只报字符数', () => {
		const singleLine = buildFoldMarker('E:\\x\\t.txt', {omittedLines: 0, omittedChars: 999});
		expect(singleLine).toContain('已省略 999 字符');
		expect(singleLine).not.toContain('0 行');
	});

	it('给出绝对路径', () => {
		expect(marker).toContain('E:\\proj\\.commandcode\\temp\\s\\tool-output\\t1.txt');
	});

	it('明确要求用 read_file 读、别重跑命令', () => {
		expect(marker).toContain('read_file');
		expect(marker).toContain('不要重跑原命令');
	});
});
