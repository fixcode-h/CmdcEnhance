// mod 开关的统一口径。
//
// `--mod-option` 是全局命名空间，flag 名一律带 mod 前缀，避免不同 mod 撞名。
//
// 读值的两条纪律：
//  - **默认开启**时判定写 `!== false` 是不够的：`--mod-option x=0` 会被 CLI 按 boolean
//    声明转成 false，但 `x=false` 在某些声明下可能原样以字符串到手。统一在这里容错，
//    别让每个 mod 各写一套。
//  - 缺省值时**必须回落到 flag 自己的 default**，而不是当成 false —— 否则没传参就等于关闭。

export interface FlagReader {
	getFlag(name: string): boolean | string | undefined;
}

const FALSEY = new Set(['false', '0', 'no', 'off']);

/** flag 是否生效；未设置 / 空串回落 `fallback`。 */
export function flagEnabled(cmd: FlagReader, name: string, fallback = true): boolean {
	const value = cmd.getFlag(name);
	if (value === undefined || value === null) return fallback;
	if (typeof value === 'boolean') return value;
	const text = value.trim().toLowerCase();
	if (!text) return fallback;
	return !FALSEY.has(text);
}
