/**
 * 能力演示：用真实的工具调用路径画 6 张图，再用 Pillow 拼成一张图集。
 * 每张图都走 geometry_draw 的完整链路（编译 → 自检 → SVG/PNG 落盘）。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGeometryTool, resolveConfig } from '../index.js';

// 输出到本脚本旁边的 demo/，因此从任何目录、任何 clone 都能跑。
const testsDir = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(testsDir, 'demo');
mkdirSync(outDir, { recursive: true });

const tool = createGeometryTool({ tools: { register() {} } }, resolveConfig({ outputDir: 'demo', scale: 2 }));
const exec = { agent: { session: { header: { cwd: testsDir } } } };

const demo = {
	// 1. 布尔差集 + 线性渐变：圆盘挖出五角星孔
	'01-boolean-gradient': {
		width: 460, height: 460, background: '#ffffff',
		elements: [{
			type: 'boolean', boolean: 'difference',
			fill: { type: 'linear', from: [-4, -4], to: [4, 4], stops: [{ offset: 0, color: '#93c5fd' }, { offset: 1, color: '#1d4ed8' }] },
			stroke: '#1e3a8a', stroke_width: 1.6,
			elements: [
				{ type: 'circle', center: [0, 0], radius: 5 },
				{ type: 'star', center: [0, 0], radius: 5.6, inner_radius: 2.4, points: 5 },
			],
		}],
	},
	// 2. 轮廓偏移做环带 + 图案填充（同一个星形外扩/内缩后相减）
	'02-offset-ring-pattern': {
		width: 460, height: 460, background: '#ffffff',
		elements: [{
			type: 'boolean', boolean: 'difference',
			fill: { type: 'pattern', tile: 44, background: '#fef3c7', shapes: [{ type: 'diagonal', color: '#f59e0b', stroke_width: 9 }] },
			stroke: '#b45309', stroke_width: 1.4,
			fill_rule: 'evenodd',
			elements: [
				{ type: 'star', center: [0, 0], radius: 7, inner_radius: 3, points: 7, offset: 0.7 },
				{ type: 'star', center: [0, 0], radius: 7, inner_radius: 3, points: 7, offset: -0.7 },
			],
		}],
	},
	// 3. 旋转阵列 + 镜像：12 瓣雪花
	'03-repeat-mirror': {
		width: 460, height: 460, background: '#0b1020',
		elements: [
			{
				type: 'path',
				d: 'M0 1.6 L0.9 3.2 L0.35 3.6 L1.1 5.4 L0.4 5.8 L0.9 7.4 L0.25 8.2 L0 7.8 L-0.25 8.2 L-0.9 7.4 L-0.4 5.8 L-1.1 5.4 L-0.35 3.6 L-0.9 3.2 L0 1.6 Z',
				fill: '#bfdbfe', opacity: 0.95,
				repeat: { count: 12, about: [0, 0], mirror_each: true },
			},
			{ type: 'circle', center: [0, 0], radius: 1.6, fill: '#fbbf24', stroke: '#f59e0b', stroke_width: 1.2 },
			{ type: 'circle', center: [0, 0], radius: 9.2, fill: 'none', stroke: '#1e293b', stroke_width: 0.8 },
		],
	},
	// 4. 极坐标玫瑰线 + 填色 + 径向渐变
	'04-polar-rose': {
		width: 460, height: 460, background: '#ffffff',
		xRange: [-7, 7], yRange: [-7, 7],
		elements: [
			{
				type: 'polar', r: '5 * cos(3 * theta)',
				fill: { type: 'radial', center: [0, 0], radius: 5, stops: [{ offset: 0, color: '#fda4af' }, { offset: 1, color: '#be123c' }] },
				stroke: '#881337', stroke_width: 1.4,
			},
			{ type: 'circle', center: [0, 0], radius: 0.25, fill: '#111827' },
		],
	},
	// 5. 参数方程曲线：李萨如（自身闭合，可直接填色）
	'05-parametric-lissajous': {
		width: 460, height: 460, background: '#ffffff',
		xRange: [-7, 7], yRange: [-7, 7],
		elements: [{
			type: 'parametric', x: '6 * cos(3 * t)', y: '6 * sin(4 * t)', range: [0, '2 * pi'], samples: 1600,
			fill: '#0f766e', fill_opacity: 0.9, fill_rule: 'evenodd',
			stroke: '#134e4a', stroke_width: 1.2,
		}],
	},
	// 6. 几何标注：三角形 + 角弧 + 直角 + 尺寸线
	'06-annotation': {
		width: 560, height: 440, background: '#ffffff',
		xRange: [-7, 7], yRange: [-4, 5],
		elements: [
			{ type: 'polygon', points: [[-5, -2.5], [5, -2.5], [1, 4]], fill: '#dbeafe', stroke: '#1d4ed8', stroke_width: 1.8 },
			{ type: 'point', at: [-5, -2.5], label: 'A', label_offset: [-16, 12] },
			{ type: 'point', at: [5, -2.5], label: 'B', label_offset: [12, 12] },
			{ type: 'point', at: [1, 4], label: 'C', label_offset: [10, -14] },
			{ type: 'angle', at: [-5, -2.5], from: [5, -2.5], to: [1, 4], radius: 1.6, label: 'α' },
			{ type: 'angle', at: [1, 4], from: [-5, -2.5], to: [5, -2.5], radius: 1.1, right: true },
			{ type: 'dimension', from: [-5, -2.5], to: [5, -2.5], offset: -1.1, label: '10' },
			{ type: 'text', at: [-6.4, 4.4], text: 'annotated construction', size: 15, anchor: 'start' },
		],
	},
};

const results = [];
for (const [name, spec] of Object.entries(demo)) {
	const value = await tool.execute({ figure: spec, name, path: outDir, scale: 2 }, exec);
	results.push({ name, png: `${outDir}/${name}.png`, value });
	console.log(
		`ok ${name}: ${value.pngWidth}x${value.pngHeight} 轮廓 ${value.stats.rings} 点 ${value.stats.points}` +
			(value.warnings.length > 0 ? ` 警告 ${value.warnings.length}: ${value.warnings[0]}` : ''),
	);
}

writeFileSync(`${outDir}/manifest.json`, JSON.stringify(results.map((r) => ({ name: r.name, png: r.png, stats: r.value.stats })), null, 2), 'utf8');
console.log('\n输出目录:', outDir);
