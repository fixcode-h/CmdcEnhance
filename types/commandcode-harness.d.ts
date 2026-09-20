// `@commandcode/harness` 没有发布到 npm（404），mod 只有 `import type` 会用到它，
// 运行时由 jiti 在 cmdc 进程内解析。这里声明本项目实际用到的表面，让 tsc 能过；
// 完整契约见 cmdc 自带的 mod-builder 技能 reference/api.md。
//
// 只增不改地补：写新 mod 用到新成员时，往这里加对应的签名。

declare module '@commandcode/harness' {
	export interface Disposable {
		dispose(): void;
	}

	export interface ModFlagOptions {
		readonly type: 'boolean' | 'string';
		readonly default?: boolean | string;
		readonly description?: string;
	}

	export interface TokenUsage {
		readonly inputTokens?: number;
		readonly outputTokens?: number;
		readonly cacheReadTokens?: number;
		readonly cacheWriteTokens?: number;
	}

	/** `cmd.on` 收到的事件；只列本项目读过的字段。 */
	export interface AgentEvent {
		readonly type: string;
		readonly model?: string;
		/** `run_start`：本会话 id。用来给落盘目录分桶，跨会话互不覆盖。 */
		readonly sessionId?: string;
		readonly usage?: TokenUsage;
		/** `text_delta` / `thinking_delta`：本次增量文本（估算流式速度用）。 */
		readonly delta?: string;
		/** `compaction_done`：本次压缩省下的 token（自动压缩只在 >0 时带）。 */
		readonly tokensSaved?: number;
		/** `compaction_done`：本会话累计省下的 token。 */
		readonly totalTokensSaved?: number;
		/** `compaction_done`：`manual` 表示 `/compact` 触发。 */
		readonly trigger?: string;
		readonly [key: string]: unknown;
	}

	export type AgentEventType = string;

	export interface ModUi {
		setStatus(text: string | null): void;
		/** 往 notice 流里加一行。长输入被转成文件引用时用它告知用户。 */
		notify(message: string, level?: 'info' | 'warning' | 'error'): void;
	}

	/** `beforeToolCall` 收到的这一次工具调用。 */
	export interface ModToolCall {
		readonly toolCallId: string;
		readonly toolName: string;
		readonly input: Record<string, unknown>;
		readonly state: unknown;
	}

	/** `beforeToolCall` 的返回：`input` 改写真正执行的入参（显示仍是原始输入）。 */
	export interface BeforeToolCallResult {
		readonly input?: Record<string, unknown>;
		readonly block?: boolean;
		readonly additionalContext?: string;
		readonly terminate?: boolean;
	}

	/** `afterToolCall` 收到的这一次工具调用（执行之后）。 */
	export interface ModAfterToolCall {
		readonly toolCallId: string;
		readonly toolName: string;
		/** 工具**实际执行**用的入参（已经过 beforeToolCall 改写）。 */
		readonly input: Record<string, unknown>;
		/**
		 * 工具结果。形状不统一：可能是纯字符串，也可能是 content block 数组。
		 * 所以处理前必须先探测形状，认不出来就原样放行（fail-open）。
		 */
		readonly result: unknown;
		/** 工具自身执行是否失败（在任何 hook 覆写之前）。 */
		readonly isError: boolean;
		readonly state: unknown;
	}

	export interface ModAfterToolCallResult {
		/** 整体替换模型看到的工具结果；形状应与 result 一致。 */
		readonly content?: unknown;
		readonly isError?: boolean;
		readonly terminate?: boolean;
		readonly additionalContext?: string;
		readonly modState?: Record<string, unknown>;
	}

	export interface TransformInputPayload {
		readonly text: string;
	}

	/** `transformInput` 的返回：改写 / 吞掉 / 放行。 */
	export type TransformInputResult =
		| {readonly action: 'continue'}
		| {readonly action: 'transform'; readonly text: string}
		| {readonly action: 'handled'; readonly message?: string};

	export interface TransformContextPayload {
		/** 本轮的完整消息列表。结果是**临时的**，不会写回 state.messages。 */
		readonly messages: readonly unknown[];
		readonly state?: unknown;
	}

	export interface ModHooks {
		beforeToolCall?(
			call: ModToolCall,
		): BeforeToolCallResult | undefined | Promise<BeforeToolCallResult | undefined>;
		afterToolCall?(
			call: ModAfterToolCall,
		): ModAfterToolCallResult | undefined | Promise<ModAfterToolCallResult | undefined>;
		transformInput?(
			input: TransformInputPayload,
		): TransformInputResult | undefined | Promise<TransformInputResult | undefined>;
		/** 每轮模型调用前改写上下文。返回**同一引用**表示没改动。 */
		transformContext?(
			payload: TransformContextPayload,
		): readonly unknown[] | Promise<readonly unknown[]>;
	}

	export interface ModApi {
		readonly name: string;
		readonly cwd: string;
		readonly ui: ModUi;
		addFlag(name: string, options: ModFlagOptions): Disposable;
		getFlag(name: string): boolean | string | undefined;
		on(
			event: AgentEventType | 'session_start' | 'session_shutdown',
			handler: (event: AgentEvent) => void,
		): Disposable;
		hooks(hooks: ModHooks): Disposable;
	}

	export type ModFactory = (cmd: ModApi) => void | Promise<void>;
}
