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
		readonly usage?: TokenUsage;
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

	export interface ModHooks {
		beforeToolCall?(
			call: ModToolCall,
		): BeforeToolCallResult | undefined | Promise<BeforeToolCallResult | undefined>;
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
