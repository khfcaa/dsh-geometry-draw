/** 编译器冒烟测试：覆盖布尔、偏移、渐变、图案、对称、标注、参数曲线 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { compileSpec } from '../src/compiler.js';
import { loadResvg } from './load-resvg.mjs';

const { Resvg } = await loadResvg();

const outDir = new URL('./out/', import.meta.url).pathname.replace(/^\//, '');
mkdirSync(outDir, { recursive: true });

const cases = {
	'布尔与填色': {
		width: 520,
		height: 420,
		background: '#ffffff',
		title: 'Boolean ops & fills',
		elements: [
			{
				type: 'boolean',
				boolean: 'difference',
				fill: { type: 'linear', from: [-5, 0], to: [5, 5], stops: [{ offset: 0, color: '#60a5fa' }, { offset: 1, color: '#1d4ed8' }] },
				stroke: '#1e3a8a',
				stroke_width: 1.4,
				elements: [
					{ type: 'circle', center: [0, 0], radius: 4.4 },
					{ type: 'star', center: [0, 0], radius: 5.2, inner_radius: 2.2, points: 5 },
				],
			},
			{
				type: 'boolean',
				boolean: 'intersect',
				fill: '#f59e0b',
				fill_opacity: 0.85,
				elements: [
					{ type: 'circle', center: [6.5, 0.5], radius: 3.4 },
					{ type: 'rect', center: [7.6, 0.5], width: 4, height: 4, transform: { rotate: 22 } },
				],
			},
		],
	},
	'环与孔洞': {
		width: 420,
		height: 420,
		background: '#ffffff',
		elements: [
			{
				type: 'boolean',
				boolean: 'difference',
				fill: { type: 'pattern', tile: 14, background: '#fef3c7', shapes: [{ type: 'diagonal', color: '#f59e0b', stroke_width: 3 }] },
				stroke: '#b45309',
				elements: [
					{ type: 'circle', center: [0, 0], radius: 6 },
					{ type: 'circle', center: [-1.6, 0], radius: 2.4 },
					{ type: 'circle', center: [1.6, 0], radius: 2.4 },
					{ type: 'rect', center: [0, -4.2], width: 5, height: 1.6 },
				],
			},
		],
	},
	'对称阵列': {
		width: 460,
		height: 460,
		background: '#0b1020',
		elements: [
			{
				type: 'path',
				d: 'M0 0 L0 5.5 L1.2 6.4 L0 7.4 L-1.2 6.4 L0 5.5 Z',
				fill: '#93c5fd',
				opacity: 0.9,
				repeat: { count: 12, about: [0, 0] },
			},
			{ type: 'circle', center: [0, 0], radius: 2.1, fill: '#fbbf24', stroke: '#f59e0b' },
			{ type: 'circle', center: [0, 0], radius: 8.4, fill: 'none', stroke: '#334155', stroke_width: 0.6 },
		],
	},
	'标注与曲线': {
		width: 560,
		height: 420,
		background: '#ffffff',
		elements: [
			{
				type: 'polygon',
				points: [[-6, -3], [5, -3], [1, 4]],
				fill: '#dbeafe',
				stroke: '#1d4ed8',
				stroke_width: 1.6,
			},
			{ type: 'point', at: [-6, -3], label: 'A' },
			{ type: 'point', at: [5, -3], label: 'B' },
			{ type: 'point', at: [1, 4], label: 'C' },
			{ type: 'angle', at: [-6, -3], from: [5, -3], to: [1, 4], radius: 1.5, label: 'α' },
			{ type: 'angle', at: [1, 4], from: [-6, -3], to: [5, -3], radius: 1.1, right: true },
			{ type: 'dimension', from: [-6, -3], to: [5, -3], offset: -0.9, label: '11' },
			{ type: 'text', at: [-5.6, 4.4], text: '三角标注示例', size: 15, anchor: 'start' },
		],
	},
};

let failures = 0;
for (const [name, spec] of Object.entries(cases)) {
	try {
		const result = compileSpec(spec, { background: 'transparent' });
		const svgPath = `${outDir}${name}.svg`;
		writeFileSync(svgPath, result.svg, 'utf8');
		const renderer = new Resvg(result.svg, { fitTo: { mode: 'width', value: result.width }, font: { loadSystemFonts: true } });
		const png = renderer.render().asPng();
		writeFileSync(`${outDir}${name}.png`, png);
		console.log(`ok   ${name}: ${result.width}x${result.height}, svg ${result.svg.length}B, png ${png.length}B, 元素 ${result.stats.rendered}`);
	} catch (error) {
		failures += 1;
		console.log(`FAIL ${name}: ${error.message}`);
	}
}
if (failures > 0) process.exit(1);
console.log('\n全部渲染成功，输出目录:', outDir);
