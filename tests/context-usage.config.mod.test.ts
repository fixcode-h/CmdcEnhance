import {describe, expect, it, vi} from 'vitest';

// config.json 是可变的：第二个用例要验「读不到时仍回落兜底」。
// vi.mock 的工厂会被提升到文件顶部，所以共享状态必须走 vi.hoisted。
const mockFs = vi.hoisted(() => ({
	configContent: JSON.stringify({model: 'acme/big'}) as string | undefined,
}));

vi.mock('node:fs', () => ({
	readFileSync: (path: unknown) => {
		const value = String(path);
		if (value.endsWith('config.json')) {
			if (mockFs.configContent === undefined) throw new Error('ENOENT: config.json');
			return mockFs.configContent;
		}
		if (value.endsWith('providers.json')) {
			return JSON.stringify({provider: {acme: {models: {big: {contextWindow: 500_000}}}}});
		}
		throw new Error(`ENOENT: ${value}`);
	},
}));

import contextUsageMod from '../mods/context-usage';

type Handler = (event: Record<string, unknown>) => void;

function fakeCmd() {
	const handlers = new Map<string, Handler[]>();
	const frames: string[] = [];
	return {
		frames,
		ui: {setStatus: (text: string | null) => void frames.push(text ?? '')},
		addFlag: () => ({dispose: () => {}}),
		getFlag: () => undefined,
		on: (event: string, handler: Handler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			return {dispose: () => {}};
		},
		last: () => frames.at(-1) ?? '',
	};
}

describe('contextUsageMod 首屏上限', () => {
	it('挂载时就用 config.json 的模型解析上限，不再落到 ~200k', () => {
		mockFs.configContent = JSON.stringify({model: 'acme/big'});
		const cmd = fakeCmd();
		contextUsageMod(cmd as never);
		expect(cmd.last()).toContain('0/500k');
		expect(cmd.last()).not.toContain('~');
	});

	it('config.json 读不到时仍回落兜底估算', () => {
		mockFs.configContent = undefined;
		const cmd = fakeCmd();
		contextUsageMod(cmd as never);
		expect(cmd.last()).toContain('0/~200k');
	});
});
