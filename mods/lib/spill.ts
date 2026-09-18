// 把大段文本落到项目内的临时文件，供模型或用户回看。
//
// 落点：`<cwd>/.commandcode/temp/<sessionId>/<group>/<name>`
//
// 为什么是项目级（实测过的选型，不是随手定的）：
//  - **`~/.commandcode/` 下的路径一律不能用**：read_file 会以 `is outside workspace` 拒绝。
//    那里是 CLI 的配置与数据目录（含 auth.json、session 记录、projects/），有安全策略。
//    `~/.commandcode/temp`、`~/.commandcode/projects/<proj>/` 都实测被拒——名字上最像，
//    但恰恰是唯一不能用的地方。文件写得进去、模型读不出来，那「折叠」就变成「丢数据」。
//  - home 下其它目录、系统 temp 实测**都读得到**，所以项目级并非硬约束，而是选择：
//    跟着项目走、能随项目一起清理、不污染全局、`.commandcode/` 也已被 gitignore 覆盖。
//  - `read_file` 要的是**绝对路径**，所以提示词里给 `abs`。
//
// 目录分层：sessionId → 会话隔离，连 toolCallId 撞车都不会互相覆盖；group → 用途分开。

import {mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

/** 相对 workspace 根的临时目录。 */
export const TEMP_DIR = '.commandcode/temp';

/**
 * 把任意字符串压成安全的路径片段。
 * 允许 `.` `-` `_`，其余折叠成 `-`；去掉首尾的点和短横，防止 `.` / `..` 逃出目录。
 */
export function sanitizeKey(raw: string | undefined | null, fallback: string): string {
	const cleaned = String(raw ?? '')
		.trim()
		.replace(/[^A-Za-z0-9._-]+/g, '-')
		.replace(/^[.\-]+/, '')
		.replace(/[.\-]+$/, '')
		.slice(0, 64);
	return cleaned || fallback;
}

/** FNV-1a 32 位；给粘贴内容生成稳定短指纹。 */
export function shortHash(text: string): string {
	let hash = 0x811c9dc5;
	for (let index = 0; index < text.length; index += 1) {
		hash ^= text.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, '0');
}

export interface SpillRequest {
	/** workspace 根；落盘位置以它为基准。 */
	readonly cwd: string;
	readonly sessionKey: string;
	/** 二级分组，如 tool-output / pasted。 */
	readonly group: string;
	/** 文件名，如 `<toolCallId>.txt`。 */
	readonly name: string;
	readonly text: string;
}

export interface SpillFile {
	/** 绝对路径：写进提示词给模型，read_file 要的就是完整路径。 */
	readonly abs: string;
	/** 相对 workspace 根的路径（正斜杠），用于给人看。 */
	readonly rel: string;
}

/** 写盘；任何失败都返回 undefined，调用方据此 fail-open。 */
export function spillText(request: SpillRequest): SpillFile | undefined {
	try {
		const session = sanitizeKey(request.sessionKey, 'session');
		const group = sanitizeKey(request.group, 'misc');
		const name = sanitizeKey(request.name, 'output.txt');
		const dir = join(request.cwd, TEMP_DIR, session, group);
		mkdirSync(dir, {recursive: true});
		const abs = join(dir, name);
		writeFileSync(abs, request.text, 'utf8');
		return {abs, rel: [TEMP_DIR, session, group, name].join('/')};
	} catch {
		return undefined;
	}
}
