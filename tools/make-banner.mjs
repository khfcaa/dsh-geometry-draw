/**
 * 生成仓库头图 `docs/assets/banner.png`。
 *
 * 分工：几何由 tools/make-examples.mjs 出图（用的是插件自己的编译器），
 * 排版由 tools/make-banner.py 用 PIL 按像素拼版。头图本身不参与插件运行时。
 *
 * 为什么不在一个文件里做完：几何引擎的 xRange 是「内容范围」，画布留白来自
 * padding，世界原点并不落在像素中心；用几何 DSL 做像素级排版会一直在跟这个
 * 偏差较劲（第一版头图就是这么废掉的）。让合适的工具做合适的事。
 *
 * 用法：node tools/make-banner.mjs
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assetsDir = path.join(repoRoot, 'examples', 'assets');
const outDir = path.join(repoRoot, 'docs', 'assets');
mkdirSync(outDir, { recursive: true });

// 先确保示例图存在（缺图时头图会缺格子，不如直接重建一遍）
const examples = spawnSync(process.execPath, [path.join(repoRoot, 'tools', 'make-examples.mjs')], {
	stdio: 'inherit',
});
if (examples.status !== 0) throw new Error('示例图生成失败，头图不再继续');

const python = process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
const bannerPng = path.join(outDir, 'banner.png');

const result = spawnSync(python, [path.join(repoRoot, 'tools', 'make-banner.py'), assetsDir, bannerPng], {
	stdio: 'inherit',
	env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
});
if (result.status !== 0) {
	throw new Error(`排版失败（python=${python}，可用 PYTHON 环境变量指定解释器）`);
}
if (!existsSync(bannerPng)) throw new Error(`没有生成 ${bannerPng}`);
