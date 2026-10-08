/**
 * 定位 @resvg/resvg-js —— 插件的 PNG 栅格化依赖。
 *
 * 为什么不直接 `import '@resvg/resvg-js'`：本插件在 DSH 里是以 `file:` 依赖装进
 * 某个 profile 的，而 Node 按**真实路径**做模块解析——真实路径是插件源码目录，
 * 那里通常没有 resvg（它随 harness 的 math 插件装在 profile 的 node_modules）。
 * 所以按「从最可能到最兜底」依次尝试：
 *
 *   1. 常规解析（独立 clone + `npm install` 的开发者走这条）
 *   2. 当前 profile 的 node_modules（DSH_PROFILE_DIR）
 *   3. DSH_HOME 下 web / desktop 两个 profile 的 node_modules
 *
 * 全部失败就抛出一句人话，告诉使用者怎么补依赖。
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function bases() {
	const list = [import.meta.url];
	const profileDir = process.env.DSH_PROFILE_DIR;
	if (typeof profileDir === 'string' && profileDir.length > 0) {
		list.push(pathToFileURL(path.join(profileDir, 'node_modules', 'noop.js')).href);
	}
	const home = process.env.DSH_HOME;
	if (typeof home === 'string' && home.length > 0) {
		for (const profile of ['web', 'desktop']) {
			list.push(pathToFileURL(path.join(home, 'profiles', profile, 'node_modules', 'noop.js')).href);
		}
	}
	return list;
}

export async function loadResvg() {
	// 先试真正的 ESM 解析：独立 clone + npm install 的开发者走这条，最干净。
	try {
		return await import('@resvg/resvg-js');
	} catch {
		// 继续用 createRequire 从 profile 的 node_modules 解析
	}
	for (const base of bases()) {
		try {
			return createRequire(base)('@resvg/resvg-js');
		} catch {
			// 换下一个候选位置
		}
	}
	throw new Error(
		'@resvg/resvg-js 不可解析：请在插件目录执行 `npm install`，或设置 DSH_PROFILE_DIR 指向已装该依赖的 profile。',
	);
}
