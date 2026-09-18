import {describe, expect, it} from 'vitest';
import {flagEnabled, flagList, flagPositiveInt} from '../mods/lib/flags';

function reader(flags: Record<string, string | boolean | undefined>) {
	return {getFlag: (name: string) => flags[name]};
}

describe('flagEnabled', () => {
	it('未设置时回落 fallback（默认开启）', () => {
		expect(flagEnabled(reader({}), 'x')).toBe(true);
		expect(flagEnabled(reader({}), 'x', false)).toBe(false);
	});

	it('boolean 直接生效', () => {
		expect(flagEnabled(reader({x: false}), 'x')).toBe(false);
		expect(flagEnabled(reader({x: true}), 'x')).toBe(true);
	});

	it('字符串按内容判定，不按真假值判定', () => {
		// 'false' 是非空字符串，JS 里为真值——这正是要在这里挡住的情况。
		expect(flagEnabled(reader({x: 'false'}), 'x')).toBe(false);
		expect(flagEnabled(reader({x: '0'}), 'x')).toBe(false);
		expect(flagEnabled(reader({x: 'NO'}), 'x')).toBe(false);
		expect(flagEnabled(reader({x: 'off'}), 'x')).toBe(false);
		expect(flagEnabled(reader({x: 'true'}), 'x')).toBe(true);
		expect(flagEnabled(reader({x: '1'}), 'x')).toBe(true);
	});

	it('两边空白不影响判定', () => {
		expect(flagEnabled(reader({x: '  false  '}), 'x')).toBe(false);
	});

	it('空串回落 fallback 而不是当成 false', () => {
		expect(flagEnabled(reader({x: ''}), 'x')).toBe(true);
		expect(flagEnabled(reader({x: '   '}), 'x')).toBe(true);
	});
});

describe('flagPositiveInt', () => {
	it('正常取整', () => {
		expect(flagPositiveInt(reader({x: '20000'}), 'x', 100)).toBe(20_000);
		expect(flagPositiveInt(reader({x: '12.9'}), 'x', 100)).toBe(12);
	});

	it('非法值回落', () => {
		expect(flagPositiveInt(reader({}), 'x', 100)).toBe(100);
		expect(flagPositiveInt(reader({x: 'abc'}), 'x', 100)).toBe(100);
		expect(flagPositiveInt(reader({x: '0'}), 'x', 100)).toBe(100);
		expect(flagPositiveInt(reader({x: '-5'}), 'x', 100)).toBe(100);
		expect(flagPositiveInt(reader({x: '  '}), 'x', 100)).toBe(100);
	});

	it('boolean 不是数字，回落', () => {
		expect(flagPositiveInt(reader({x: true}), 'x', 100)).toBe(100);
	});
});

describe('flagList', () => {
	it('未设置回落默认列表', () => {
		expect(flagList(reader({}), 'x', ['a', 'b'])).toEqual(['a', 'b']);
	});

	it('切分并去掉空白', () => {
		expect(flagList(reader({x: ' a , b ,c '}), 'x', [])).toEqual(['a', 'b', 'c']);
	});

	it('显式空串表示空列表（能真的清空排除表）', () => {
		expect(flagList(reader({x: ''}), 'x', ['a'])).toEqual([]);
	});

	it('多余逗号不产生空项', () => {
		expect(flagList(reader({x: 'a,,b,'}), 'x', [])).toEqual(['a', 'b']);
	});

	it('返回副本，改它不污染传入的默认列表', () => {
		const fallback = ['a'];
		flagList(reader({}), 'x', fallback).push('b');
		expect(fallback).toEqual(['a']);
	});
});
