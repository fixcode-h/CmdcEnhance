import {describe, expect, it} from 'vitest';
import {FOLD_MARKER_TAG} from '../mods/lib/text';
import {
	SLIM_MARKER_TAG,
	buildSlimPlaceholder,
	collectToolResults,
	countMessageChars,
	isAlreadySlimmed,
	selectSlimTargets,
	withSlimmedText,
	type ToolResultRef,
} from '../mods/context-slim';

function toolResultMessage(toolUseId: string, text: string): unknown {
	return {role: 'user', content: [{type: 'tool_result', tool_use_id: toolUseId, content: [{type: 'text', text}]}]};
}

describe('collectToolResults', () => {
	it('取出 tool_result 的 id 与文本', () => {
		const refs = collectToolResults([toolResultMessage('call_1', 'hello')]);
		expect(refs).toHaveLength(1);
		expect(refs[0].toolUseId).toBe('call_1');
		expect(refs[0].text).toBe('hello');
		expect(refs[0].chars).toBe(5);
		expect(refs[0].messageIndex).toBe(0);
		expect(refs[0].blockIndex).toBe(0);
	});

	it('content 是纯字符串时也能取到', () => {
		const message = {role: 'user', content: [{type: 'tool_result', tool_use_id: 'c', content: 'plain'}]};
		expect(collectToolResults([message])[0].text).toBe('plain');
	});

	it('拼接多个 text 块，忽略非文本块', () => {
		const message = {
			role: 'user',
			content: [
				{
					type: 'tool_result',
					tool_use_id: 'c',
					content: [{type: 'text', text: 'a'}, {type: 'image'}, {type: 'text', text: 'b'}],
				},
			],
		};
		expect(collectToolResults([message])[0].text).toBe('ab');
	});

	it('非 tool_result 块被跳过', () => {
		const message = {role: 'assistant', content: [{type: 'text', text: 'hi'}, {type: 'tool_use', id: 'x'}]};
		expect(collectToolResults([message])).toHaveLength(0);
	});

	it('缺 tool_use_id 的结果跳过（无法稳定标识）', () => {
		const message = {role: 'user', content: [{type: 'tool_result', content: [{type: 'text', text: 'x'}]}]};
		expect(collectToolResults([message])).toHaveLength(0);
	});

	it('形状不认识时不抛', () => {
		expect(collectToolResults([])).toHaveLength(0);
		expect(collectToolResults([null, 42, 'str'])).toHaveLength(0);
		expect(collectToolResults([{role: 'user'}])).toHaveLength(0);
	});

	it('记录正确的消息下标', () => {
		const refs = collectToolResults([
			{role: 'user', content: [{type: 'text', text: 'q'}]},
			toolResultMessage('call_a', 'x'),
			{role: 'user', content: [{type: 'text', text: 'y'}]},
			toolResultMessage('call_b', 'z'),
		]);
		expect(refs.map(r => r.messageIndex)).toEqual([1, 3]);
		expect(refs.map(r => r.toolUseId)).toEqual(['call_a', 'call_b']);
	});
});

describe('countMessageChars', () => {
	it('累计文本载荷的字符数', () => {
		expect(countMessageChars([{role: 'user', content: [{type: 'text', text: 'abcd'}]}])).toBe(4);
	});

	it('数组形式的 content 也能数', () => {
		expect(countMessageChars([{role: 'user', content: 'abcdef'}])).toBe(6);
	});

	it('空输入是 0', () => {
		expect(countMessageChars([])).toBe(0);
	});
});

describe('isAlreadySlimmed', () => {
	it('认自己的标记', () => {
		expect(isAlreadySlimmed(`${SLIM_MARKER_TAG} 已归档`)).toBe(true);
	});

	it('**不**把 output-fold 的标记算作已归档', () => {
		// 两个 mod 默认同时生效。fold 过的内容仍占上万字符，正是最该被 slim 归档的那批；
		// 若这里也跳过，context-slim 在默认配置下将永远无事可做（真机验证时踩到过）。
		expect(isAlreadySlimmed(`${FOLD_MARKER_TAG} 已省略`)).toBe(false);
	});

	it('普通内容不算', () => {
		expect(isAlreadySlimmed('普通的工具输出')).toBe(false);
	});
});

describe('selectSlimTargets', () => {
	const ref = (id: string, messageIndex: number, chars: number): ToolResultRef => ({
		messageIndex,
		blockIndex: 0,
		toolUseId: id,
		text: 'x'.repeat(chars),
		chars,
	});

	const base = {
		messageCount: 20,
		keepMessages: 4,
		minUnitChars: 1_000,
		needChars: 10_000,
		minYieldChars: 0,
		alreadySlimmed: new Set<string>(),
	};

	it('从最大的开始挑，够 needChars 就停', () => {
		const refs = [ref('small', 1, 1_500), ref('big', 2, 8_000), ref('mid', 3, 4_000)];
		const picked = selectSlimTargets({...base, refs});
		expect(picked.map(p => p.toolUseId)).toEqual(['big', 'mid']);
	});

	it('最近的消息永不触碰', () => {
		// messageCount=20、keepMessages=4 → 下标 >= 16 的不合格
		const refs = [ref('old', 5, 9_000), ref('recent', 17, 9_000)];
		expect(selectSlimTargets({...base, refs}).map(p => p.toolUseId)).toEqual(['old']);
	});

	it('小于最小单体的不挑（占位符本身也有成本）', () => {
		const refs = [ref('tiny', 1, 500)];
		expect(selectSlimTargets({...base, refs})).toHaveLength(0);
	});

	it('已归档过的跳过', () => {
		const refs = [ref('done', 1, 9_000)];
		const picked = selectSlimTargets({...base, refs, alreadySlimmed: new Set(['done'])});
		expect(picked).toHaveLength(0);
	});

	it('已带折叠标记的内容仍然可以被归档（默认两个 mod 同时生效）', () => {
		const folded: ToolResultRef = {
			messageIndex: 1,
			blockIndex: 0,
			toolUseId: 'f',
			text: `${FOLD_MARKER_TAG} ${'x'.repeat(9000)}`,
			chars: 9_000,
		};
		expect(selectSlimTargets({...base, refs: [folded]}).map(p => p.toolUseId)).toEqual(['f']);
	});

	it('没有可释放的返回空数组（调用方据此不动手）', () => {
		expect(selectSlimTargets({...base, refs: []})).toHaveLength(0);
	});

	it('needChars 很小时只挑一个最大的就够', () => {
		const refs = [ref('big', 1, 9_000), ref('mid', 2, 5_000)];
		const picked = selectSlimTargets({...base, refs, needChars: 1});
		expect(picked.map(p => p.toolUseId)).toEqual(['big']);
	});

	it('可释放量低于 minYield 时直接放弃（不做无意义的前缀改动）', () => {
		const refs = [ref('a', 1, 3_000), ref('b', 2, 2_000)];
		expect(selectSlimTargets({...base, refs, minYieldChars: 10_000})).toHaveLength(0);
	});

	it('可释放量刚好够 minYield 就动手', () => {
		const refs = [ref('a', 1, 3_000), ref('b', 2, 2_000)];
		expect(selectSlimTargets({...base, refs, minYieldChars: 5_000})).toHaveLength(2);
	});

	it('needChars 够不着时，能释放多少就释放多少（部分缓解胜于不做）', () => {
		const refs = [ref('a', 1, 3_000), ref('b', 2, 2_000)];
		const picked = selectSlimTargets({...base, refs, needChars: 999_999, minYieldChars: 1_000});
		expect(picked).toHaveLength(2);
	});
});

describe('buildSlimPlaceholder', () => {
	const path = 'E:\\proj\\.commandcode\\temp\\s\\slimmed\\call_1.txt';

	it('带标记、路径与原字符数', () => {
		const text = buildSlimPlaceholder(path, 12_345);
		expect(text).toContain(SLIM_MARKER_TAG);
		expect(text).toContain(path);
		expect(text).toContain('12345');
	});

	it('明确要求用 read_file 读回，别凭记忆猜', () => {
		const text = buildSlimPlaceholder(path, 100);
		expect(text).toContain('read_file');
		expect(text).toContain('不要凭记忆猜测');
	});

	it('字节稳定：同样的输入给出完全相同的文本（缓存命中的前提）', () => {
		expect(buildSlimPlaceholder(path, 999)).toBe(buildSlimPlaceholder(path, 999));
	});

	it('不含随时间变化的内容', () => {
		const text = buildSlimPlaceholder(path, 100);
		expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}/);
		expect(text).not.toMatch(/\d{2}:\d{2}:\d{2}/);
	});
});

describe('withSlimmedText', () => {
	const messages = [
		{role: 'user', content: [{type: 'text', text: '问题'}]},
		{
			role: 'assistant',
			content: [{type: 'tool_use', id: 'call_1', name: 'shell_command', input: {}}],
		},
		toolResultMessage('call_1', '原始的大段输出'),
	];

	it('替换命中的 tool_result 文本', () => {
		const out = withSlimmedText(messages, new Map([['call_1', 'REPLACED']])) as Record<
			string,
			unknown
		>[];
		const block = (out[2].content as Record<string, unknown>[])[0];
		expect(block.content).toEqual([{type: 'text', text: 'REPLACED'}]);
	});

	it('**保留 tool_use / tool_result 的配对**（删块会造成 wire 格式错误）', () => {
		const out = withSlimmedText(messages, new Map([['call_1', 'R']])) as Record<string, unknown>[];
		const assistant = out[1].content as Record<string, unknown>[];
		const result = (out[2].content as Record<string, unknown>[])[0];
		expect(assistant[0].id).toBe('call_1');
		expect(result.tool_use_id).toBe('call_1');
		expect(out).toHaveLength(3);
	});

	it('没命中时返回同一个引用（向 hook 表示没变）', () => {
		expect(withSlimmedText(messages, new Map([['other', 'X']]))).toBe(messages);
	});

	it('替换表为空时返回同一个引用', () => {
		expect(withSlimmedText(messages, new Map())).toBe(messages);
	});

	it('不修改未命中的消息（引用保持）', () => {
		const out = withSlimmedText(messages, new Map([['call_1', 'R']])) as unknown[];
		expect(out[0]).toBe(messages[0]);
		expect(out[1]).toBe(messages[1]);
	});

	it('不改动原数组（纯函数）', () => {
		const copy = JSON.parse(JSON.stringify(messages));
		withSlimmedText(messages, new Map([['call_1', 'R']]));
		expect(JSON.parse(JSON.stringify(messages))).toEqual(copy);
	});

	it('形状不认识时不抛', () => {
		expect(withSlimmedText([null, 1, 'x'], new Map([['a', 'b']]))).toHaveLength(3);
	});
});
