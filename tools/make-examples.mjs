/**
 * 生成 `examples/assets/*` 里那 6 张示例图。
 *
 * 两个设计决定，都是踩过坑之后定的：
 *
 * 1. **背景透明**。这些图要同时能放在 README 的浅色与深色主题上，白底会在深色
 *    主题里变成一个刺眼的方块。
 * 2. **每张图单独渲染**，不用 `compileSpec` 的 `title`。标题交给排版工具做，
 *    画布只负责几何。
 *
 * 关于坐标系的一个坑，写在这里免得后人再踩：编译器的 `xRange` 是**内容范围**，
 * 默认 `padding: 16` 会再给画布留白，所以世界原点并不正好落在画布中心（1280 宽的
 * 画布上会偏右约 35px）。做像素级排版时不能依赖「世界原点 = 画布中心」；因此
 * 本文件里的图形一律**关于原点对称**，偏移在视觉上被对称性抵消。要叠加文字或
 * 拼版，请用 tools/make-banner.py 那种真正按像素定位的工具。
 *
 * 用法：node tools/make-examples.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileSpec } from '../src/compiler.js';
import { auditFigure } from '../src/validate.js';
import { loadResvg } from '../tests/load-resvg.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(repoRoot, 'examples', 'assets');
const examplesDir = path.join(repoRoot, 'examples');
mkdirSync(outDir, { recursive: true });
mkdirSync(examplesDir, { recursive: true });

const SIZE = 560;
const RANGE = [-12, 12];
const RENDER_AT = 2; // 2x：README 在 retina 屏上不糊

/**
 * 紧凑版 JSON 美化：坐标数组保持在一行。
 * `JSON.stringify(v, null, 2)` 会把 `[0, 0]` 拆成三行，导出的示例文件没法读；
 * 这里只对「纯数字数组」做内联，其余照常缩进。
 */
function prettyJson(value, indent = 0) {
	const pad = '  '.repeat(indent);
	const childPad = '  '.repeat(indent + 1);
	if (Array.isArray(value)) {
		if (value.length === 0) return '[]';
		if (value.every((item) => typeof item === 'number')) {
			return `[${value.map((item) => JSON.stringify(item)).join(', ')}]`;
		}
		return `[\n${value.map((item) => `${childPad}${prettyJson(item, indent + 1)}`).join(',\n')}\n${pad}]`;
	}
	if (value !== null && typeof value === 'object') {
		const entries = Object.entries(value);
		if (entries.length === 0) return '{}';
		return `{\n${entries
			.map(([key, item]) => `${childPad}${JSON.stringify(key)}: ${prettyJson(item, indent + 1)}`)
			.join(',\n')}\n${pad}}`;
	}
	return JSON.stringify(value);
}

/** 每张图：规格 + 中文标题 + 英文标题（图集与 README 都用得上）。 */
export const gallery = [
	{
		name: '01-boolean-gradient',
		title: '布尔差集 + 线性渐变',
		caption: 'boolean difference + linear gradient',
		spec: {
			elements: [{
				// 显式声明 fill_rule：多轮廓 + 方向相反时不能靠默认行为，自检也会因此报警。
				type: 'boolean', boolean: 'difference', fill_rule: 'evenodd',
				fill: {
					type: 'linear', from: [-8, -8], to: [8, 8],
					stops: [{ offset: 0, color: '#93c5fd' }, { offset: 1, color: '#1d4ed8' }],
				},
				stroke: '#1e3a8a', stroke_width: 0.3,
				elements: [
					{ type: 'circle', center: [0, 0], radius: 8 },
					// 星形必须完全落在圆内：外半径 × cos(π/5) > 内半径，五个星尖之间
					// 才是连续的内凹缺口——否则星尖会把圆周切开，得到一块碎掉的圆盘。
					{ type: 'star', center: [0, 0], radius: 7.2, inner_radius: 3.9, points: 5 },
				],
			}],
		},
	},
	{
		name: '02-offset-ring-pattern',
		title: '轮廓偏移环带 + 图案填充',
		caption: 'contour offset ring + pattern fill',
		spec: {
			elements: [{
				type: 'boolean', boolean: 'difference', fill_rule: 'evenodd',
				fill: {
					type: 'pattern', tile: 74, background: '#fef3c7',
					shapes: [{ type: 'diagonal', color: '#f59e0b', stroke_width: 15 }],
				},
				stroke: '#b45309', stroke_width: 0.28,
				// 环带 = 同一个圆，一个外扩一个内缩，相减。用圆而不是多角星：
				// 星形的凹角在偏移后容易自交，圆没有这个风险。
				elements: [
					{ type: 'circle', center: [0, 0], radius: 8.2, offset: 1.1 },
					{ type: 'circle', center: [0, 0], radius: 8.2, offset: -1.1 },
				],
			}],
		},
	},
	{
		name: '03-repeat-mirror',
		title: '旋转阵列 + 镜像（12 瓣）',
		caption: 'rotational array + mirror (12 arms)',
		spec: {
			background: '#0b1020',
			elements: [
				{
					type: 'path',
					d: 'M0 1.6 L0.9 3.2 L0.35 3.6 L1.1 5.4 L0.4 5.8 L0.9 7.4 L0.25 8.2 L0 7.8 L-0.25 8.2 L-0.9 7.4 L-0.4 5.8 L-1.1 5.4 L-0.35 3.6 L-0.9 3.2 L0 1.6 Z',
					fill: '#bfdbfe', fill_opacity: 0.95,
					repeat: { count: 12, about: [0, 0], mirror_each: true },
				},
				{ type: 'circle', center: [0, 0], radius: 1.9, fill: '#fbbf24', stroke: '#f59e0b', stroke_width: 0.25 },
				{ type: 'circle', center: [0, 0], radius: 10.4, fill: 'none', stroke: '#334155', stroke_width: 0.25 },
			],
		},
	},
	{
		name: '04-polar-rose',
		title: '极坐标玫瑰线 r = 5.6cos(3θ)',
		caption: 'polar rose (3 petals) + radial gradient',
		spec: {
			xRange: [-8, 8], yRange: [-8, 8],
			elements: [
				{
					// 玫瑰线的花瓣数：n 为奇数时是 n 瓣，偶数时才是 2n 瓣。所以
					// r = a·cos(3θ) 就是 3 瓣（不是 6 瓣），想要 6 瓣得写 r = a·cos(6θ)。
					// 奇数 n 的周期是 π，扫满 2π 只是把同一朵花描两遍，不会多出花瓣。
					// 这里额外加 +π/2 的相位，让一瓣朝正上方，构图对称好看。
					type: 'polar', r: '5.6 * cos(3 * (theta - pi / 2))',
					fill: {
						type: 'radial', center: [0, 0], radius: 5.8,
						stops: [{ offset: 0, color: '#fda4af' }, { offset: 1, color: '#be123c' }],
					},
					stroke: '#881337', stroke_width: 0.22,
				},
				{ type: 'circle', center: [0, 0], radius: 0.32, fill: '#111827' },
			],
		},
	},
	{
		name: '05-parametric-lissajous',
		title: '参数方程：李萨如曲线',
		caption: 'parametric Lissajous (self-intersecting)',
		spec: {
			xRange: [-8, 8], yRange: [-8, 8],
			elements: [{
				type: 'parametric', x: '6.8 * cos(3 * t)', y: '6.8 * sin(4 * t)',
				range: [0, '2 * pi'], samples: 2400,
				fill: '#0f766e', fill_opacity: 0.9, fill_rule: 'evenodd',
				stroke: '#134e4a', stroke_width: 0.18,
			}],
		},
	},
	{
		name: '06-annotation',
		title: '几何标注：顶点 / 角弧 / 直角 / 尺寸',
		caption: 'annotated construction',
		spec: {
			xRange: [-8, 8], yRange: [-8, 8],
			elements: [
				{ type: 'polygon', points: [[-6, -3], [6, -3], [1, 5]], fill: '#dbeafe', stroke: '#1d4ed8', stroke_width: 0.3 },
				{ type: 'point', at: [-6, -3], label: 'A', label_offset: [-22, 14] },
				{ type: 'point', at: [6, -3], label: 'B', label_offset: [14, 14] },
				{ type: 'point', at: [1, 5], label: 'C', label_offset: [12, -18] },
				// 角弧画在顶点附近的小半径上；直角符号同理。
				{ type: 'angle', at: [-6, -3], from: [6, -3], to: [1, 5], radius: 2.4, label: 'α' },
				{ type: 'angle', at: [1, 5], from: [-6, -3], to: [6, -3], radius: 1.6, right: true },
				// offset 为正 = 往图形外（下方）推。第一版用了负值，尺寸线直接穿进三角形里。
				{ type: 'dimension', from: [-6, -3], to: [6, -3], offset: 2.2, label: '12' },
			],
		},
	},
];

const { Resvg } = await loadResvg();
const manifest = [];

for (const figure of gallery) {
	const spec = {
		width: SIZE, height: SIZE, padding: 20,
		background: figure.spec.background ?? 'transparent',
		xRange: figure.spec.xRange ?? RANGE,
		yRange: figure.spec.yRange ?? RANGE,
		elements: figure.spec.elements,
	};
	const compiled = compileSpec(spec, { background: 'transparent' });
	// 自检走插件真正用的那一条路径：示例图不应该有任何 warning。
	const audit = auditFigure({ spec, compiled: compiled.elements ?? [], range: compiled.range, canvas: compiled, svg: compiled.svg });

	writeFileSync(path.join(outDir, `${figure.name}.svg`), compiled.svg, 'utf8');
	const rendered = new Resvg(compiled.svg, {
		fitTo: { mode: 'width', value: SIZE * RENDER_AT },
		font: { loadSystemFonts: true },
	}).render();
	writeFileSync(path.join(outDir, `${figure.name}.png`), rendered.asPng());

	const warnings = [...compiled.warnings, ...audit.warnings];
	manifest.push({
		name: figure.name,
		title: figure.title,
		caption: figure.caption,
		png: `examples/assets/${figure.name}.png`,
		svg: `examples/assets/${figure.name}.svg`,
		spec: `examples/${figure.name}.json`,
		canvas: [compiled.width, compiled.height],
		pixel: [rendered.width, rendered.height],
		stats: { ...audit.stats, elements: compiled.stats.elements, rendered: compiled.stats.rendered },
		warnings,
	});

	// 同时导出一份**可直接喂给 geometry_draw 的**规格文件：
	// README 里贴的就是它，读者可以照抄进自己的会话。
	writeFileSync(
		path.join(examplesDir, `${figure.name}.json`),
		`${prettyJson({ name: figure.name, title: figure.title, figure: spec })}\n`,
		'utf8',
	);
	console.log(
		`ok ${figure.name}: ${rendered.width}x${rendered.height}  ` +
		`轮廓 ${audit.stats.rings} 点 ${audit.stats.points}` +
		(warnings.length > 0 ? `  警告 ${warnings.length}: ${warnings[0]}` : ''),
	);
}

writeFileSync(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(`\n输出目录：${outDir}`);
