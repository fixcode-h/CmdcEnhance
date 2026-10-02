import {describe, expect, it} from 'vitest';
import {flagEnabled} from '../mods/lib/flags';

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
