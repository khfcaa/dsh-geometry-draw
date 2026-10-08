/** 工具层自测：直接调用 geometry_draw 的 execute，检查文件落盘与结果结构 */
import { mkdtempSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { apply, createGeometryTool, resolveConfig } from '../index.js';

let passed = 0;
const failures = [];
function check(name, condition, detail = '') {
	if (condition) {
		passed += 1;
		console.log(`  ok   ${name}`);
	} else {
		failures.push(`${name} ${detail}`);
		console.log(`  FAIL ${name} ${detail}`);
	}
}

// 用临时目录当工作区
const root = mkdtempSync(path.join(tmpdir(), 'geo-tool-'));
const registered = [];
const ctx = {
	tools: { register: (definition) => registered.push(definition) },
};
const config = resolveConfig({ outputDir: 'geometry', scale: 2 });
apply(ctx, { outputDir: 'geometry', scale: 2 });

check('注册了一个工具', registered.length === 1, `(got ${registered.length})`);
const tool = registered[0] ?? createGeometryTool(ctx, config);
check('工具名正确', tool.name === 'geometry_draw', tool.name);
check('工具声明了必需参数 figure', Array.isArray(tool.parameters?.required) && tool.parameters.required.includes('figure'));

const exec = { agent: { session: { header: { cwd: root } } }, signal: undefined };

console.log('\n[1] 基本绘制与文件落盘');
{
	const value = await tool.execute(
		{
			figure: {
				width: 300,
				height: 240,
				background: '#ffffff',
				elements: [
					{ type: 'circle', center: [0, 0], radius: 4, fill: '#3b82f6', stroke: '#1e3a8a' },
					{ type: 'rect', center: [3, 2], width: 3, height: 2, fill: '#f59e0b', transform: { rotate: 30 } },
				],
			},
			name: 'smoke',
		},
		exec,
	);
	check('返回 svgPath 与 pngPath', typeof value.svgPath === 'string' && typeof value.pngPath === 'string', JSON.stringify({ svg: value.svgPath, png: value.pngPath }));
	check('文件真的存在', existsSync(path.join(root, value.svgPath)) && existsSync(path.join(root, value.pngPath)));
	check('PNG 尺寸符合 scale=2', value.pngWidth === 600 && value.pngHeight === 480, `${value.pngWidth}x${value.pngHeight}`);
	check('markdown 片段指向 PNG', value.markdown.includes(value.pngPath));
	check('无警告', value.warnings.length === 0, JSON.stringify(value.warnings));
	const svgText = readFileSync(path.join(root, value.svgPath), 'utf8');
	check('SVG 自包含（声明了 xmlns）', svgText.startsWith('<svg xmlns="http://www.w3.org/2000/svg"'));
}

console.log('\n[2] 布尔运算形状');
{
	const value = await tool.execute(
		{
			figure: {
				xRange: [-8, 8],
				yRange: [-6, 6],
				elements: [
					{
						type: 'boolean',
						boolean: 'difference',
						fill: '#10b981',
						elements: [
							{ type: 'circle', center: [0, 0], radius: 6 },
							{ type: 'star', center: [0, 0], radius: 7, inner_radius: 3, points: 6 },
						],
					},
				],
			},
			name: 'bool',
			format: 'svg',
		},
		exec,
	);
	// 可选字段用空串表示「无」：DSH 的工具输出 schema 只接受单类型，不能是 null。
	check('只写 SVG', typeof value.svgPath === 'string' && value.pngPath === '');
	const svgText = readFileSync(path.join(root, value.svgPath), 'utf8');
	const subpaths = (svgText.match(/M/g) ?? []).length;
	check('差集产生了多个子路径（挖出孔洞）', subpaths > 1, `M 出现 ${subpaths} 次`);
	check('用 evenodd 填充多轮廓', svgText.includes('fill-rule="evenodd"'), svgText.slice(0, 200));
}

console.log('\n[3] 自检能抓出问题');
{
	const value = await tool.execute(
		{
			figure: {
				xRange: [-5, 5],
				yRange: [-5, 5],
				elements: [
					{ type: 'polygon', points: [[0, 0], [1, 1], [2, 2]], fill: '#000' },
					{ type: 'polygon', points: [[-3, -3], [1, -4], [3, 1], [-1, 2]], fill: '#333' },
				],
			},
			name: 'degenerate',
			format: 'svg',
		},
		exec,
	);
	check('报告退化轮廓', value.warnings.some((warning) => warning.includes('共线')), JSON.stringify(value.warnings));
	check('统计里有退化计数', value.stats.degenerate >= 1, JSON.stringify(value.stats));
}

console.log('\n[4] 参数校验与沙箱边界');
{
	let threw = false;
	try {
		await tool.execute({ figure: { elements: [] }, unknown_arg: 1 }, exec);
	} catch (error) {
		threw = error.message.includes('unknown argument');
	}
	check('未知参数被拒绝', threw);

	threw = false;
	try {
		await tool.execute({ figure: { elements: [] }, path: '../escape.svg' }, exec);
	} catch (error) {
		threw = error.message.includes('outside the session workspace');
	}
	check('路径逃逸被拒绝', threw);

	threw = false;
	try {
		await tool.execute({ figure: { elements: [{ type: 'nope' }] } }, exec);
	} catch (error) {
		threw = error.message.includes('unsupported element type');
	}
	check('未知元素类型被拒绝', threw);

	threw = false;
	try {
		await tool.execute({ figure: { elements: [{ type: 'point', at: 'Z' }] } }, exec);
	} catch (error) {
		threw = error.message.includes('named point');
	}
	check('未定义的点引用被拒绝', threw);
}

console.log('\n[5] 表达式与变量');
{
	const value = await tool.execute(
		{
			figure: {
				vars: { n: 8, r: '3 + 1' },
				xRange: ['-r - 1', 'r + 1'],
				yRange: ['-r - 1', 'r + 1'],
				elements: [
					{
						type: 'parametric',
						x: 'r * cos(t)',
						y: 'r * sin(t)',
						range: [0, '2 * pi'],
						fill: '#ef4444',
					},
				],
			},
			name: 'expr',
			format: 'svg',
		},
		exec,
	);
	check('表达式与 vars 可用', typeof value.svgPath === 'string' && value.warnings.length === 0, JSON.stringify(value.warnings));
}

console.log(`\n通过 ${passed} 项，失败 ${failures.length} 项`);
if (failures.length > 0) {
	for (const f of failures) console.log('  - ' + f);
	process.exit(1);
}
