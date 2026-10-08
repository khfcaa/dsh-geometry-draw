/**
 * 几何规格（DSL）→ SVG 编译器
 *
 * 坐标约定：规格里的一切都
*数学坐标**（x 向右、y 向上）里描述，编译器
 * 内部完成全部几何运算后，丢次把结果写成屏幕坐标SVG。文字类元素不进
 * 翻转变换，单独按屏幕坐标绘制—否则字会上下颠倒
 */

import {
	distPt,
	formatNumber,
	leftNormal,
	normalizePt,
	subPt,
	matApply,
	matMul,
	matRotate,
	matScale,
	matTranslate,
	matMirror,
	IDENTITY,
} from './math.js';
import { compileExpression, resolveNumber } from './expr.js';
import { flattenPathData } from './path.js';
import { booleanRings, normalizeRings, offsetRings } from './geometry.js';

const HEX_COLOR = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const NAMED_COLOR = /^[a-zA-Z]{3,24}$/;
const FUNCTIONAL_COLOR = /^(?:rgb|rgba|hsl|hsla)\(\s*[0-9.,%\s/]+\)$/;

const DEFAULT_CANVAS = { width: 720, height: 540, padding: 16 };
const MAX_ELEMENTS = 2000;
const MAX_REPEAT = 200;

export function isSafeColor(value) {
	if (typeof value !== 'string') return false;
	const trimmed = value.trim();
	if (trimmed.length === 0 || trimmed.length > 64) return false;
	return HEX_COLOR.test(trimmed) || NAMED_COLOR.test(trimmed) || FUNCTIONAL_COLOR.test(trimmed) || trimmed === 'none';
}

function fail(message) {
	throw new Error(`geometry: ${message}`);
}

function escapeAttribute(value) {
	return String(value)
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&apos;');
}

function escapeText(value) {
	return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

// ---------------------------------------------------------------- 规格准备

function readCanvas(spec, overrides) {
	const canvas = { ...DEFAULT_CANVAS, ...overrides };
	if (spec.width !== undefined) canvas.width = requireInteger(spec.width, 'width', 40, 4000);
	if (spec.height !== undefined) canvas.height = requireInteger(spec.height, 'height', 40, 4000);
	if (spec.padding !== undefined) canvas.padding = requireInteger(spec.padding, 'padding', 0, 128);
	return canvas;
}

function requireInteger(value, what, min, max) {
	if (typeof value !== 'number' || !Number.isInteger(value)) fail(`"${what}" must be an integer`);
	if (value < min || value > max) fail(`"${what}" must be between ${min} and ${max}`);
	return value;
}

/** 解析 `vars`：可以是数字，也可以是引用前面名字的表达
*/
function resolveVars(raw) {
	const out = {};
	if (raw === undefined) return out;
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) fail('"vars" must be an object');
	for (const [key, value] of Object.entries(raw)) {
		if (typeof value === 'number') {
			out[key] = value;
			continue;
		}
		if (typeof value === 'string') {
			out[key] = compileExpression(value, Object.keys(out))(out);
			continue;
		}
		fail(`"vars.${key}" must be a number or an expression string`);
	}
	return out;
}

// ---------------------------------------------------------------- 形状解析

/** 把一个元素解析成「环」集合（数学坐标），返回 undefined 表示它不产生几何 */
function resolveShapeGeometry(element, context) {
	const { vars } = context;
	const kind = element.type;
	const toNumbers = (list, what) => {
		if (!Array.isArray(list)) fail(`"${what}" must be an array of points`);
		return list.map((point) => parsePoint(point, vars, what));
	};

	switch (kind) {
		case 'rect': {
			const width = resolveNumber(element.width, vars, `${kind}.width`);
			const height = resolveNumber(element.height, vars, `${kind}.height`);
			const center = element.center === undefined ? [0, 0] : parsePoint(element.center, vars, `${kind}.center`);
			const radius = element.rx !== undefined || element.ry !== undefined
				? [resolveNumber(element.rx ?? 0, vars, `${kind}.rx`), resolveNumber(element.ry ?? 0, vars, `${kind}.ry`)]
				: null;
			const x0 = center[0] - width / 2;
			const y0 = center[1] - height / 2;
			if (radius === null || (radius[0] <= 0 && radius[1] <= 0)) {
				return [
					[
						[x0, y0],
						[x0 + width, y0],
						[x0 + width, y0 + height],
						[x0, y0 + height],
					],
				];
			}
			return [roundedRect(x0, y0, width, height, radius[0], radius[1])];
		}
		case 'circle': {
			const center = parsePoint(element.center, vars, `${kind}.center`);
			const radius = resolveNumber(element.radius, vars, `${kind}.radius`);
			if (radius <= 0) fail(`${kind}: radius must be positive`);
			return [ellipseRing(center, radius, radius, 96)];
		}
		case 'ellipse': {
			const center = parsePoint(element.center, vars, `${kind}.center`);
			const rx = resolveNumber(element.rx, vars, `${kind}.rx`);
			const ry = resolveNumber(element.ry, vars, `${kind}.ry`);
			if (rx <= 0 || ry <= 0) fail(`${kind}: radii must be positive`);
			return [ellipseRing(center, rx, ry, 96)];
		}
		case 'polygon': {
			if (!Array.isArray(element.points) || element.points.length < 3) fail(`${kind}: needs at least 3 points`);
			return [toNumbers(element.points, `${kind}.points`)];
		}
		case 'polyline': {
			if (!Array.isArray(element.points) || element.points.length < 2) fail(`${kind}: needs at least 2 points`);
			return [toNumbers(element.points, `${kind}.points`)];
		}
		case 'star': {
			const center = parsePoint(element.center, vars, `${kind}.center`);
			const outer = resolveNumber(element.radius, vars, `${kind}.radius`);
			const inner = element.inner_radius !== undefined
				? resolveNumber(element.inner_radius, vars, `${kind}.inner_radius`)
				: outer * 0.5;
			const points = requireInteger(element.points ?? 5, `${kind}.points`, 3, 200);
			const phase = element.phase === undefined ? Math.PI / 2 : (resolveNumber(element.phase, vars, `${kind}.phase`) * Math.PI) / 180;
			const ring = [];
			for (let i = 0; i < points * 2; i += 1) {
				const radius = i % 2 === 0 ? outer : inner;
				const angle = phase + (Math.PI * i) / points;
				ring.push([center[0] + radius * Math.cos(angle), center[1] + radius * Math.sin(angle)]);
			}
			return [ring];
		}
		case 'path': {
			if (typeof element.d !== 'string' || element.d.trim().length === 0) fail(`${kind}: "d" must be a non-empty string`);
			const tolerance = context.tolerance;
			return normalizeRings(
				flattenPathData(element.d, tolerance).map((sub) => (sub.closed ? sub.points : closeOpenSubpath(sub.points))),
			);
		}
		case 'curve': {
			// y = f(x)
			if (typeof element.y !== 'string') fail('curve: "y" must be an expression in x');
			const domain = readRange(element.domain, [-5, 5], context, 'curve.domain');
			const samples = requireInteger(element.samples ?? 320, 'curve.samples', 8, 8000);
			const fn = compileExpression(element.y, [...Object.keys(vars), 'x']);
			return sampleCurve(samples, (t) => {
				const value = fn({ ...vars, x: t });
				return [t, value];
			}, domain);
		}
		case 'parametric': {
			if (typeof element.x !== 'string' || typeof element.y !== 'string') {
				fail('parametric: "x" and "y" must be expressions in t');
			}
			const range2 = readRange(element.range, [0, Math.PI * 2], context, 'parametric.range');
			const samples = requireInteger(element.samples ?? 480, 'parametric.samples', 8, 8000);
			const fx = compileExpression(element.x, [...Object.keys(vars), 't']);
			const fy = compileExpression(element.y, [...Object.keys(vars), 't']);
			return sampleCurve(samples, (t) => [fx({ ...vars, t }), fy({ ...vars, t })], range2);
		}
		case 'polar': {
			if (typeof element.r !== 'string') fail('polar: "r" must be an expression in theta');
			const range2 = readRange(element.range, [0, Math.PI * 2], context, 'polar.range');
			const samples = requireInteger(element.samples ?? 720, 'polar.samples', 8, 8000);
			const fr = compileExpression(element.r, [...Object.keys(vars), 'theta', 'θ']);
			return sampleCurve(samples, (theta) => {
				const radius = fr({ ...vars, theta, θ: theta });
				return [radius * Math.cos(theta), radius * Math.sin(theta)];
			}, range2);
		}
		default:
			return undefined;
	}
}

/**
 * 采样函数曲线，遇到不连续（跳变远大于相邻步长）就断开
 * `tan(x)` 的极点`ln(x)` x 的定义域外都会因此形成断线，而不
 * 画出丢条横跨整幅图的假竖线—这是函数图像的经典坑
 */
function sampleCurve(samples, evaluate, [from, to]) {
	const points = [];
	let previous;
	for (let i = 0; i <= samples; i += 1) {
		const t = from + ((to - from) * i) / samples;
		let point;
		try {
			point = evaluate(t);
		} catch {
			previous = undefined;
			continue;
		}
		if (!Number.isFinite(point[0]) || !Number.isFinite(point[1])) {
			previous = undefined;
			continue;
		}
		points.push(point);
		previous = point;
	}
	void previous;
	if (points.length === 0) return [];
	// 相邻点距离超过整体跨度的 25% 视为跳变，切弢

	const box = points.reduce(
		(acc, [x, y]) => ({
			minX: Math.min(acc.minX, x),
			minY: Math.min(acc.minY, y),
			maxX: Math.max(acc.maxX, x),
			maxY: Math.max(acc.maxY, y),
		}),
		{ minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
	);
	const span = Math.max(box.maxX - box.minX, box.maxY - box.minY, 1e-9);
	const segments = [];
	let current = [points[0]];
	for (let i = 1; i < points.length; i += 1) {
		if (distPt(points[i - 1], points[i]) > span * 0.25) {
			if (current.length >= 2) segments.push(current);
			current = [points[i]];
			continue;
		}
		current.push(points[i]);
	}
	if (current.length >= 2) segments.push(current);
	return segments;
}

function readRange(value, fallback, context, what) {
	if (value === undefined) return fallback;
	if (!Array.isArray(value) || value.length !== 2) fail(`${what} must be [from, to]`);
	const names = context.vars;
	return [resolveNumber(value[0], names, `${what}[0]`), resolveNumber(value[1], names, `${what}[1]`)];
}

/** 弢口子路径在填充语境下按直线闭合处理；描边另走 polyline 分支 */
function closeOpenSubpath(points) {
	if (points.length < 3) return points;
	return points;
}

function ellipseRing(center, rx, ry, segments) {
	const ring = [];
	for (let i = 0; i < segments; i += 1) {
		const angle = (2 * Math.PI * i) / segments;
		ring.push([center[0] + rx * Math.cos(angle), center[1] + ry * Math.sin(angle)]);
	}
	return ring;
}

function roundedRect(x, y, width, height, rx, ry) {
	const radius = Math.min(Math.max(rx, 0), width / 2);
	const radiusY = Math.min(Math.max(ry, 0), height / 2);
	const segments = 8;
	const ring = [];
	const corners = [
		[x + width - radius, y + radiusY, -Math.PI / 2, 0],
		[x + width - radius, y + height - radiusY, 0, Math.PI / 2],
		[x + radius, y + height - radiusY, Math.PI / 2, Math.PI],
		[x + radius, y + radiusY, Math.PI, (3 * Math.PI) / 2],
	];
	for (const [cx, cy, from, to] of corners) {
		for (let i = 0; i <= segments; i += 1) {
			const angle = from + ((to - from) * i) / segments;
			ring.push([cx + radius * Math.cos(angle), cy + radiusY * Math.sin(angle)]);
		}
	}
	return ring;
}

function parsePoint(value, vars, what) {
	if (typeof value === 'string') {
		// 具名点引用由上层解析（这里只处理坐标
		fail(`${what}: named point "${value}" is not defined`);
	}
	if (!Array.isArray(value) || value.length !== 2) fail(`${what}: a point must be [x, y]`);
	return [resolveNumber(value[0], vars, `${what}[0]`), resolveNumber(value[1], vars, `${what}[1]`)];
}

// ---------------------------------------------------------------- 变换

function parseTransform(raw, element, vars, context) {
	let matrix = IDENTITY;
	const steps = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
	for (const step of steps) {
		if (typeof step === 'string') {
			matrix = matMul(matrix, parseTransformString(step, vars, context));
			continue;
		}
		if (typeof step !== 'object' || step === null) fail('"transform" entries must be objects or strings');
		if (step.rotate !== undefined) {
			const angle = resolveNumber(step.rotate, vars, 'transform.rotate');
			const about = step.about === undefined ? [0, 0] : parsePoint(step.about, vars, 'transform.about');
			matrix = matMul(matrix, matMul(matTranslate(about[0], about[1]), matMul(matRotate(angle), matTranslate(-about[0], -about[1]))));
		}
		if (step.scale !== undefined) {
			const value = step.scale;
			const [sx, sy] = Array.isArray(value)
				? [resolveNumber(value[0], vars, 'transform.scale'), resolveNumber(value[1], vars, 'transform.scale')]
				: [resolveNumber(value, vars, 'transform.scale'), resolveNumber(value, vars, 'transform.scale')];
			const about = step.about === undefined ? [0, 0] : parsePoint(step.about, vars, 'transform.about');
			matrix = matMul(matrix, matMul(matTranslate(about[0], about[1]), matMul(matScale(sx, sy), matTranslate(-about[0], -about[1]))));
		}
		if (step.translate !== undefined) {
			const delta = parsePoint(step.translate, vars, 'transform.translate');
			matrix = matMul(matrix, matTranslate(delta[0], delta[1]));
		}
		if (step.mirror !== undefined) {
			// mirror: {axis: "x"|"y"|"angle", angle: deg, through: [x,y]}
			const through = step.through === undefined ? [0, 0] : parsePoint(step.through, vars, 'transform.through');
			let direction;
			if (step.axis === 'x') direction = [1, 0];
			else if (step.axis === 'y') direction = [0, 1];
			else if (step.angle !== undefined) {
				const angle = (resolveNumber(step.angle, vars, 'transform.angle') * Math.PI) / 180;
				direction = [Math.cos(angle), Math.sin(angle)];
			} else if (Array.isArray(step.mirror)) {
				const target = parsePoint(step.mirror, vars, 'transform.mirror');
				direction = subPt(target, through);
			} else {
				fail('transform.mirror needs axis ("x"/"y"), angle, or a target point');
			}
			matrix = matMul(matrix, matMirror(through, direction));
		}
	}
	void element;
	return matrix;
}

/** 支持 SVG 风格的变换字符串：`rotate(30) translate(1,2)` */
function parseTransformString(text, vars, context) {
	let matrix = IDENTITY;
	const pattern = /([a-zA-Z]+)\s*\(([^)]*)\)/g;
	let match;
	while ((match = pattern.exec(text)) !== null) {
		const name = match[1].toLowerCase();
		const args = match[2]
			.split(/[\s,]+/)
			.filter((part) => part.length > 0)
			.map((part) => resolveNumber(part, vars, `transform ${name}`));
		if (name === 'rotate') matrix = matMul(matrix, matRotate(args[0] ?? 0));
		else if (name === 'translate') matrix = matMul(matrix, matTranslate(args[0] ?? 0, args[1] ?? 0));
		else if (name === 'scale') matrix = matMul(matrix, matScale(args[0] ?? 1, args[1] ?? args[0] ?? 1));
		else if (name === 'matrix') matrix = matMul(matrix, args.slice(0, 6));
		else fail(`unsupported transform "${name}"`);
	}
	void context;
	return matrix;
}

function applyMatrixToRings(rings, matrix) {
	return rings.map((ring) => ring.map((point) => matApply(matrix, point)));
}

// ---------------------------------------------------------------- 编译主流

/**
 * 编译规格。返`{ svg, width, height, warnings, stats }`
 * 第一个参数是规格对象，`options` 提供画布默认值与缩放
 */
export function compileSpec(spec, options = {}) {
	if (typeof spec !== 'object' || spec === null || Array.isArray(spec)) fail('the figure spec must be an object');
	const canvas = readCanvas(spec, options);
	const warnings = [];
	const vars = resolveVars(spec.vars);
	const variableNames = vars;

	if (!Array.isArray(spec.elements)) fail('"elements" must be an array');
	if (spec.elements.length > MAX_ELEMENTS) fail(`"elements" is limited to ${MAX_ELEMENTS} entries`);

	const context = {
		vars,
		variableNames,
		tolerance: 0.1,
		// 每单位数学坐标大致占多少像素：用来把「按屏幕像素给的偏移量（如点
		// label_offset）换算回数学单位。显式给range 时这个估计就是精确；
		// 靠自动配时先按经验估值，实际尺度要等几何测完才知道
		scaleHint: estimateScale(spec, canvas, vars),
		named: new Map(),
		shapes: spec.shapes ?? {},
		colors: new Set(),
		warnings,
		gradients: new Map(),
		patterns: new Map(),
		nextId: 1,
	};

	if (context.shapes !== undefined && (typeof context.shapes !== 'object' || context.shapes === null || Array.isArray(context.shapes))) {
		fail('"shapes" must be an object mapping names to shape definitions');
	}

	// 第一遍：登记具名点，`"A"` 这样的引用使	registerNamedPoints(spec.elements, context);

	// 第二遍：编译成中间表示（数学坐标里的+ 样式 + 文字
	const compiled = [];
	for (const element of spec.elements) {
		compileElement(element, context, IDENTITY, compiled, { inherited: {} });
	}

	// 自动适配范围（没有显式指定时由几何包围盒决定
	const bounds = measureCompiled(compiled);
	const range = resolveRange(spec, bounds, canvas, vars);
	const scale = range.scale;

	context.scaleHint = scale;
	context.tolerance = 0.1 / scale;

	// 文字元素的位置在编译期按「数学单位算好了，label_offset 之类是按屏幕
	// 像素给的；两者混在同丢份中间表示里，所以位置字段统丢用数学单位，
	// 渲染时再scale—这里把像素偏移换算成数学单位的那一步已经在编译期完成
	const body = [];
	const overlay = [];
	for (const item of compiled) {
		if (item.kind === 'text') {
			overlay.push(renderText(item, range, canvas));
			continue;
		}
		const rendered = renderShape(item, range, canvas, context);
		if (rendered !== null) body.push(rendered);
	}

	const defs = renderDefs(context, range, canvas);
	const background = spec.background !== undefined ? spec.background : options.background;
	const backgroundRect = isSafeColor(background) && background !== 'transparent'
		? `<rect width="${canvas.width}" height="${canvas.height}" fill="${escapeAttribute(background)}"/>`
		: '';
	const title = spec.title === undefined ? '' : renderTitle(spec.title, canvas, scale);

	const svg = [
		`<svg xmlns="http://www.w3.org/2000/svg" width="${canvas.width}" height="${canvas.height}" viewBox="0 0 ${canvas.width} ${canvas.height}">`,
		defs.length > 0 ? `<defs>${defs.join('')}</defs>` : '',
		backgroundRect,
		body.length > 0 ? `<g>${body.join('')}</g>` : '',
		title,
		overlay.join(''),
		'</svg>',
	]
		.filter((part) => part.length > 0)
		.join('');

	return {
		svg,
		width: canvas.width,
		height: canvas.height,
		warnings,
		// 自检霢要拿到中间表示（环点、样式）来判断化与自交
		elements: compiled,
		stats: {
			elements: spec.elements.length,
			rendered: compiled.length,
			scale,
			bounds,
		},
		range,
	};
}

/** 编译前对「每单位多少像素」的估计，用于把屏幕像素偏移换算成数学单
*/
function estimateScale(spec, canvas, vars) {
	const innerW = canvas.width - canvas.padding * 2;
	const innerH = canvas.height - canvas.padding * 2;
	try {
		const names = Object.keys(vars ?? {});
		if (Array.isArray(spec.xRange) && Array.isArray(spec.yRange)) {
			const spanX = resolveNumber(spec.xRange[1], names, 'xRange[1]') - resolveNumber(spec.xRange[0], names, 'xRange[0]');
			const spanY = resolveNumber(spec.yRange[1], names, 'yRange[1]') - resolveNumber(spec.yRange[0], names, 'yRange[0]');
			if (spanX > 0 && spanY > 0) return Math.min(innerW / spanX, innerH / spanY);
		}
	} catch {
		// 表达式还没准备好时回经验
	}
	return Math.max(24, Math.min(innerW, innerH) / 12);
}

function registerNamedPoints(elements, context, matrix = IDENTITY, depth = 0) {
	if (depth > 24) return;
	for (const element of elements) {
		if (typeof element !== 'object' || element === null) continue;
		if (element.type === 'point' && typeof element.label === 'string' && element.at !== undefined) {
			const local = parsePoint(element.at, context.vars, 'point.at');
			context.named.set(element.label, matApply(matrix, local));
		}
		const own = parseTransform(element.transform, element, context.vars, context);
		const next = matMul(matrix, own);
		if (Array.isArray(element.elements)) registerNamedPoints(element.elements, context, next, depth + 1);
	}
}

function resolveRange(spec, bounds, canvas, vars) {
	const innerW = canvas.width - canvas.padding * 2;
	const innerH = canvas.height - canvas.padding * 2;
	// 注意传的是 vars 对象本身（而不是它的键名数组）：resolveNumber 需要变量
	// 的**值**来求值，只给名字会算出 NaN。
	const explicitX = Array.isArray(spec.xRange) ? resolveRangePair(spec.xRange, vars, 'xRange') : undefined;
	const explicitY = Array.isArray(spec.yRange) ? resolveRangePair(spec.yRange, vars, 'yRange') : undefined;
	if (explicitX !== undefined && explicitY !== undefined) {
		const spanX = explicitX[1] - explicitX[0];
		const spanY = explicitY[1] - explicitY[0];
		if (!(spanX > 0) || !(spanY > 0)) fail('"xRange"/"yRange" must be increasing pairs');
		const scale = Math.min(innerW / spanX, innerH / spanY);
		return { x0: explicitX[0], x1: explicitX[1], y0: explicitY[0], y1: explicitY[1], scale };
	}

	const box = bounds ?? { minX: -1, minY: -1, maxX: 1, maxY: 1 };
	const marginX = Math.max((box.maxX - box.minX) * 0.06, 1e-6);
	const marginY = Math.max((box.maxY - box.minY) * 0.06, 1e-6);
	const x0 = explicitX !== undefined ? explicitX[0] : box.minX - marginX;
	const x1 = explicitX !== undefined ? explicitX[1] : box.maxX + marginX;
	const y0 = explicitY !== undefined ? explicitY[0] : box.minY - marginY;
	const y1 = explicitY !== undefined ? explicitY[1] : box.maxY + marginY;
	const spanX = x1 - x0;
	const spanY = y1 - y0;
	if (!(spanX > 0) || !(spanY > 0)) return { x0: -1, x1: 1, y0: -1, y1: 1, scale: Math.min(innerW / 2, innerH / 2) };
	const scale = Math.min(innerW / spanX, innerH / spanY);
	return { x0, x1, y0, y1, scale };
}

/** 区间端点允许写成表达式（["-r-1", "r+1"]，r 来自 vars
*/
function resolveRangePair(pair, vars, what) {
	if (pair.length !== 2) fail(`"${what}" must be [min, max]`);
	return [resolveNumber(pair[0], vars, `${what}[0]`), resolveNumber(pair[1], vars, `${what}[1]`)];
}

function measureCompiled(compiled) {
	let box;
	for (const item of compiled) {
		if (item.rings === undefined) continue;
		for (const ring of item.rings) {
			for (const [x, y] of ring) {
				if (box === undefined) box = { minX: x, minY: y, maxX: x, maxY: y };
				else {
					if (x < box.minX) box.minX = x;
					if (y < box.minY) box.minY = y;
					if (x > box.maxX) box.maxX = x;
					if (y > box.maxY) box.maxY = y;
				}
			}
		}
		if (item.points !== undefined) {
			for (const [x, y] of item.points) {
				if (box === undefined) box = { minX: x, minY: y, maxX: x, maxY: y };
				else {
					if (x < box.minX) box.minX = x;
					if (y < box.minY) box.minY = y;
					if (x > box.maxX) box.maxX = x;
					if (y > box.maxY) box.maxY = y;
				}
			}
		}
	}
	return box;
}

/** 数学坐标 屏幕坐标 */
function toScreen(point, range, canvas) {
	return [
		canvas.padding + (point[0] - range.x0) * range.scale,
		canvas.padding + (range.y1 - point[1]) * range.scale,
	];
}

function renderShape(item, range, canvas, context) {
	if (item.kind === 'point') {
		const point = toScreen(item.points[0], range, canvas);
		const radius = Math.max(0.5, (item.size ?? 3) * (range.scale > 0 ? 1 : 1));
		const fill = item.open === true ? 'none' : (item.style.fill ?? '#111827');
		const stroke = item.open === true ? (item.style.stroke ?? '#111827') : item.style.stroke;
		const attributes = [
			`cx="${formatNumber(point[0], 2)}"`,
			`cy="${formatNumber(point[1], 2)}"`,
			`r="${formatNumber(radius, 2)}"`,
			`fill="${escapeAttribute(isSafeColor(fill) ? fill : '#111827')}"`,
		];
		if (stroke !== undefined && stroke !== null && stroke !== 'none' && isSafeColor(stroke)) {
			attributes.push(`stroke="${escapeAttribute(stroke)}"`, `stroke-width="1.4"`);
		}
		return `<circle ${attributes.join(' ')}/>`;
	}

	const rings = item.rings.map((ring) => ring.map((point) => toScreen(point, range, canvas)));
	if (rings.length === 0) return null;
	const d = rings
		.filter((ring) => ring.length >= 2)
		.map((ring) => {
			const closed = item.kind === 'stroke' ? false : true;
			const body = ring.map((p, index) => `${index === 0 ? 'M' : 'L'}${formatNumber(p[0], 2)} ${formatNumber(p[1], 2)}`).join(' ');
			return closed ? `${body} Z` : body;
		})
		.join(' ');
	if (d.length === 0) return null;
	const attributes = [`d="${d}"`];
	appendPaint(attributes, item, context, canvas);
	return `<path ${attributes.join(' ')}/>`;
}

function appendPaint(attributes, item, context, canvas) {
	const style = item.style ?? {};
	const fill = style.fill ?? '#000000';
	const stroke = style.stroke;
	const fillRule = style.fill_rule ?? (item.rings.length > 1 ? 'evenodd' : 'nonzero');
	if (fill === 'none') attributes.push('fill="none"');
	else attributes.push(`fill="${escapeAttribute(resolvePaint(fill, item, context, canvas))}"`);
	if (fillRule === 'evenodd' && item.rings.length > 1) attributes.push('fill-rule="evenodd"');
	if (style.fill_opacity !== undefined) attributes.push(`fill-opacity="${formatNumber(style.fill_opacity, 3)}"`);
	if (stroke !== undefined && stroke !== 'none') {
		attributes.push(`stroke="${escapeAttribute(resolvePaint(stroke, item, context, canvas))}"`);
		attributes.push(`stroke-width="${formatNumber(style.stroke_width ?? 1.6, 3)}"`);
		if (style.stroke_dasharray !== undefined) {
			const pattern = Array.isArray(style.stroke_dasharray) ? style.stroke_dasharray.join(' ') : String(style.stroke_dasharray);
			attributes.push(`stroke-dasharray="${escapeAttribute(pattern)}"`);
		}
		if (style.stroke_linecap !== undefined) attributes.push(`stroke-linecap="${escapeAttribute(style.stroke_linecap)}"`);
		if (style.stroke_linejoin !== undefined) attributes.push(`stroke-linejoin="${escapeAttribute(style.stroke_linejoin)}"`);
		if (style.stroke_opacity !== undefined) attributes.push(`stroke-opacity="${formatNumber(style.stroke_opacity, 3)}"`);
	} else if (style.stroke === 'none') {
		attributes.push('stroke="none"');
	}
	if (style.opacity !== undefined) attributes.push(`opacity="${formatNumber(style.opacity, 3)}"`);
	if (style.mix_blend_mode !== undefined) attributes.push(`style="mix-blend-mode:${escapeAttribute(style.mix_blend_mode)}"`);
}

/** 渐变/图案引用就地defs 里登记；纯色直接返回 */
function resolvePaint(paint, item, context, canvas) {
	if (typeof paint === 'string') {
		if (!isSafeColor(paint)) fail(`unsafe color or paint value "${paint}"`);
		return paint;
	}
	if (typeof paint !== 'object' || paint === null) fail('paint must be a color string or a gradient/pattern object');
	const key = JSON.stringify(paint);
	const existing = context.gradients.get(key) ?? context.patterns.get(key);
	if (existing !== undefined) return `url(#${existing})`;
	const id = `paint-${context.nextId}`;
	context.nextId += 1;
	if (paint.type === 'linear' || paint.type === 'radial' || paint.type === 'gradient') {
		context.gradients.set(key, id);
		return `url(#${id})`;
	}
	if (paint.type === 'pattern') {
		context.patterns.set(key, id);
		return `url(#${id})`;
	}
	fail(`unsupported paint type "${paint.type}"`);
}

function renderDefs(context, range, canvas) {
	const defs = [];
	for (const [key, id] of context.gradients) {
		const paint = JSON.parse(key);
		const stops = Array.isArray(paint.stops) ? paint.stops : [];
		if (stops.length === 0) fail('a gradient needs at least one stop');
		const body = stops
			.map((stop) => {
				const offset = stop.offset === undefined ? 0 : Number(stop.offset);
				const color = stop.color ?? stop.fill;
				if (!isSafeColor(color)) fail(`gradient stop color "${color}" is not a safe color`);
				const opacity = stop.opacity === undefined ? '' : ` stop-opacity="${formatNumber(stop.opacity, 3)}"`;
				return `<stop offset="${formatNumber(offset * 100, 3)}%" stop-color="${escapeAttribute(color)}"${opacity}/>`;
			})
			.join('');
		const isLinear = paint.type === 'linear' || paint.type === 'gradient';
		if (isLinear) {
			const from = paint.from === undefined ? [0, 0] : paint.from;
			const to = paint.to === undefined ? [1, 0] : paint.to;
			const a = toScreen(from, range, canvas);
			const b = toScreen(to, range, canvas);
			const units = paint.units === 'user' ? '' : ' gradientUnits="userSpaceOnUse"';
			defs.push(
				`<linearGradient id="${id}"${units} x1="${formatNumber(a[0], 2)}" y1="${formatNumber(a[1], 2)}" x2="${formatNumber(b[0], 2)}" y2="${formatNumber(b[1], 2)}">${body}</linearGradient>`,
			);
		} else {
			const center = toScreen(paint.center === undefined ? [0, 0] : paint.center, range, canvas);
			const radius = paint.radius === undefined ? 1 : Number(paint.radius);
			defs.push(
				`<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${formatNumber(center[0], 2)}" cy="${formatNumber(center[1], 2)}" r="${formatNumber(radius * range.scale, 2)}">${body}</radialGradient>`,
			);
		}
	}
	for (const [key, id] of context.patterns) {
		const paint = JSON.parse(key);
		const tile = paint.tile ?? 20;
		const background = paint.background ?? 'none';
		const body = [];
		if (paint.background !== undefined && isSafeColor(background) && background !== 'none') {
			body.push(`<rect width="${formatNumber(tile, 2)}" height="${formatNumber(tile, 2)}" fill="${escapeAttribute(background)}"/>`);
		}
		for (const shape of paint.shapes ?? []) {
			const rendered = renderPatternShape(shape, tile);
			if (rendered !== null) body.push(rendered);
		}
		defs.push(
			`<pattern id="${id}" width="${formatNumber(tile, 2)}" height="${formatNumber(tile, 2)}" patternUnits="userSpaceOnUse"${paint.rotate === undefined ? '' : ` patternTransform="rotate(${formatNumber(paint.rotate, 2)})"`}>${body.join('')}</pattern>`,
		);
	}
	return defs;
}

function renderPatternShape(shape, tile) {
	if (typeof shape !== 'object' || shape === null) return null;
	const color = shape.color ?? shape.fill ?? '#000000';
	if (!isSafeColor(color)) fail(`pattern shape color "${color}" is not a safe color`);
	const size = shape.size ?? tile * 0.2;
	const stroke = shape.stroke_width ?? size;
	if (shape.type === 'line' || shape.type === 'diagonal') {
		return `<path d="M0 0 L${formatNumber(tile, 2)} ${formatNumber(tile, 2)}" stroke="${escapeAttribute(color)}" stroke-width="${formatNumber(stroke, 2)}" fill="none"/>`;
	}
	if (shape.type === 'cross') {
		return `<path d="M0 ${formatNumber(tile / 2, 2)} H${formatNumber(tile, 2)} M${formatNumber(tile / 2, 2)} 0 V${formatNumber(tile, 2)}" stroke="${escapeAttribute(color)}" stroke-width="${formatNumber(stroke, 2)}" fill="none"/>`;
	}
	if (shape.type === 'square') {
		const inset = (tile - size) / 2;
		return `<rect x="${formatNumber(inset, 2)}" y="${formatNumber(inset, 2)}" width="${formatNumber(size, 2)}" height="${formatNumber(size, 2)}" fill="${escapeAttribute(color)}"/>`;
	}
	if (shape.type === 'triangle') {
		const inset = (tile - size) / 2;
		return `<path d="M${formatNumber(tile / 2, 2)} ${formatNumber(inset, 2)} L${formatNumber(inset + size, 2)} ${formatNumber(inset + size, 2)} L${formatNumber(inset, 2)} ${formatNumber(inset + size, 2)} Z" fill="${escapeAttribute(color)}"/>`;
	}
	if (shape.type === 'chevron') {
		return `<path d="M0 ${formatNumber(tile * 0.3, 2)} L${formatNumber(tile / 2, 2)} ${formatNumber(tile * 0.6, 2)} L${formatNumber(tile, 2)} ${formatNumber(tile * 0.3, 2)}" stroke="${escapeAttribute(color)}" stroke-width="${formatNumber(stroke, 2)}" fill="none"/>`;
	}
	// 默认：圆
	return `<circle cx="${formatNumber(tile / 2, 2)}" cy="${formatNumber(tile / 2, 2)}" r="${formatNumber(size / 2, 2)}" fill="${escapeAttribute(color)}"/>`;
}

function renderTitle(title, canvas, scale) {
	const text = typeof title === 'string' ? title : JSON.stringify(title);
	const fontSize = Math.max(12, Math.round(canvas.width / 40));
	void scale;
	return `<text x="${canvas.width / 2}" y="${fontSize + 2}" font-family="Times New Roman, Times, serif" font-size="${fontSize + 2}" text-anchor="middle" fill="#111827">${escapeText(text)}</text>`;
}

function renderText(item, range, canvas) {
	const at = toScreen(item.at, range, canvas);
	const size = item.size ?? 14;
	const attributes = [
		`x="${formatNumber(at[0], 2)}"`,
		`y="${formatNumber(at[1], 2)}"`,
		`font-size="${formatNumber(size, 2)}"`,
	];
	const family = item.family ?? (item.italic ? 'Times New Roman, Times, serif' : 'Arial, Helvetica, sans-serif');
	attributes.push(`font-family="${escapeAttribute(family)}"`);
	if (item.italic) attributes.push('font-style="italic"');
	if (item.bold) attributes.push('font-weight="bold"');
	attributes.push(`fill="${escapeAttribute(isSafeColor(item.color ?? '#111827') ? (item.color ?? '#111827') : '#111827')}"`);
	if (item.anchor !== undefined) attributes.push(`text-anchor="${escapeAttribute(item.anchor)}"`);
	const baseline = item.valign ?? 'middle';
	const shift = baseline === 'top' ? size * 0.8 : baseline === 'bottom' ? -size * 0.2 : size * 0.35;
	attributes.push(`dominant-baseline="middle"`);
	if (item.rotate !== undefined) {
		attributes.push(`transform="rotate(${formatNumber(-item.rotate, 3)} ${formatNumber(at[0], 2)} ${formatNumber(at[1] + shift, 2)})"`);
	}
	return `<text ${attributes.join(' ')}>${escapeText(item.text)}</text>`;
}

// ---------------------------------------------------------------- 元素编译

function compileElement(element, context, matrix, out, inherited) {
	if (typeof element !== 'object' || element === null) fail('each element must be an object');
	if (typeof element.type !== 'string') fail('each element needs a string "type"');
	const own = parseTransform(element.transform, element, context.vars, context);
	const local = matMul(matrix, own);
	const style = { ...inherited.inherited, ...(element.style ?? {}) };
	validateStyle(style, element.type);

	const repeat = element.repeat;
	if (repeat !== undefined) {
		compileRepeated(element, context, local, out, inherited, style, repeat);
		return;
	}
	if (element.mirror !== undefined) {
		compileMirrored(element, context, local, out, inherited, style, element.mirror);
		return;
	}
	compileSingle(element, context, local, out, style);
}

function validateStyle(style, type) {
	if (typeof style !== 'object' || style === null) fail(`"style" of ${type} must be an object`);
	for (const key of ['fill_opacity', 'stroke_opacity', 'opacity', 'stroke_width']) {
		if (style[key] !== undefined && (typeof style[key] !== 'number' || !Number.isFinite(style[key]))) {
			fail(`style.${key} must be a finite number`);
		}
	}
}

/** `repeat: {count, rotate, about, mirror_each}` —旋转阵列 */
function compileRepeated(element, context, matrix, out, inherited, style, repeat) {
	if (typeof repeat !== 'object' || repeat === null) fail('"repeat" must be an object');
	const count = requireInteger(repeat.count ?? repeat.times, 'repeat.count', 1, MAX_REPEAT);
	const rotate = resolveNumber(repeat.rotate ?? 360 / count, context.vars, 'repeat.rotate');
	const about = repeat.about === undefined
		? namedOrDefault(repeat.about_label, context, [0, 0])
		: namedOrDefault(repeat.about, context, [0, 0]);
	const shrink = repeat.shrink === undefined ? 1 : resolveNumber(repeat.shrink, context.vars, 'repeat.shrink');
	const mirrorEach = repeat.mirror_each === true;
	for (let i = 0; i < count; i += 1) {
		const around = matMul(matTranslate(about[0], about[1]), matMul(matRotate(rotate * i), matTranslate(-about[0], -about[1])));
		const scaled = matMul(matTranslate(about[0], about[1]), matMul(matScale(shrink ** i, shrink ** i), matTranslate(-about[0], -about[1])));
		const piece = { ...element, repeat: undefined, mirror: undefined };
		compileSingle(piece, context, matMul(matrix, matMul(around, scaled)), out, style);
		if (mirrorEach) {
			const flipped = { ...element, repeat: undefined, mirror: undefined };
			const reflection = matMirror(about, [Math.cos(((rotate * i) * Math.PI) / 180), Math.sin(((rotate * i) * Math.PI) / 180)]);
			compileSingle(flipped, context, matMul(matrix, matMul(around, matMul(scaled, reflection))), out, style);
		}
	}
	void inherited;
}

function namedOrDefault(value, context, fallback) {
	if (value === undefined) return fallback;
	if (typeof value === 'string') {
		const found = context.named.get(value);
		if (found === undefined) fail(`named point "${value}" is not defined`);
		return found;
	}
	return parsePoint(value, context.vars, 'point reference');
}

/** `mirror: {axis|angle|through}` —镜像复制（雪花纹章对称图案） */
function compileMirrored(element, context, matrix, out, inherited, style, mirror) {
	const spec = typeof mirror === 'object' && mirror !== null ? mirror : { axis: mirror };
	const through = spec.through === undefined ? [0, 0] : namedOrDefault(spec.through, context, [0, 0]);
	let direction;
	if (spec.axis === 'x') direction = [1, 0];
	else if (spec.axis === 'y') direction = [0, 1];
	else if (spec.angle !== undefined) {
		const angle = (resolveNumber(spec.angle, context.vars, 'mirror.angle') * Math.PI) / 180;
		direction = [Math.cos(angle), Math.sin(angle)];
	} else if (Array.isArray(spec.axis)) {
		direction = [1, 0];
	} else fail('"mirror" needs axis ("x"/"y"), angle, or through+angle');

	compileSingle({ ...element, mirror: undefined }, context, matrix, out, style);
	const reflection = matMirror(through, direction);
	compileSingle({ ...element, mirror: undefined }, context, matMul(matrix, reflection), out, style);
	void inherited;
}

function compileSingle(element, context, matrix, out, style) {
	const type = element.type;
	switch (type) {
		case 'point': {
			const at = resolvePointReference(element.at, context);
			const mapped = matApply(matrix, at);
			out.push({ kind: 'point', points: [mapped], style: pointStyle(style), size: element.size ?? style.point_size ?? 3, open: element.open === true });
			if (element.label !== undefined && element.label !== null) {
				const offset = element.label_offset ?? [10, 10];
				// label_offset 用屏幕像素表达（y 向下），这里换到数学坐标再交给屏幕转
				out.push({
					kind: 'text',
					at: [mapped[0] + Number(offset[0] ?? 0) / context.scaleHint, mapped[1] - Number(offset[1] ?? 0) / context.scaleHint],
					text: String(element.label),
					size: element.label_size ?? 14,
					color: element.color ?? '#111827',
					anchor: Number(offset[0] ?? 0) < 0 ? 'end' : 'start',
					valign: 'middle',
					italic: element.italic === true,
				});
			}
			return;
		}
		case 'text':
		case 'label': {
			const at = resolvePointReference(element.at, context);
			const mapped = matApply(matrix, at);
			const offset = element.offset ?? [0, 0];
			out.push({
				kind: 'text',
				at: [mapped[0] + Number(offset[0] ?? 0), mapped[1] + Number(offset[1] ?? 0)],
				text: String(element.text ?? element.label ?? ''),
				size: element.size ?? 14,
				color: element.color ?? '#111827',
				anchor: element.anchor,
				valign: element.valign,
				rotate: element.rotate,
				italic: element.italic === true,
				bold: element.bold === true,
				family: element.family,
			});
			return;
		}
		case 'segment':
		case 'line':
		case 'ray':
		case 'vector': {
			const from = resolvePointReference(element.from, context);
			const to = resolvePointReference(element.to ?? element.through, context);
			let ring;
			if (type === 'line') {
				const direction = normalizePt(subPt(to, from));
				if (direction[0] === 0 && direction[1] === 0) fail('line: from and to coincide');
				const length = Math.max(Math.abs(to[0] - from[0]), Math.abs(to[1] - from[1])) * 4 + 10;
				ring = [subPt(from, [direction[0] * length, direction[1] * length]), [from[0] + direction[0] * length, from[1] + direction[1] * length]];
			} else if (type === 'ray') {
				const direction = normalizePt(subPt(to, from));
				const length = Math.max(Math.abs(to[0] - from[0]), Math.abs(to[1] - from[1])) * 4 + 10;
				ring = [from, [from[0] + direction[0] * length, from[1] + direction[1] * length]];
			} else {
				ring = [from, to];
			}
			const mapped = ring.map((point) => matApply(matrix, point));
			out.push({
				kind: 'stroke',
				rings: [mapped],
				style: { ...style, fill: 'none', stroke: style.stroke ?? '#111827', stroke_width: style.stroke_width ?? 1.6 },
			});
			if (type === 'vector' || element.arrow !== undefined) {
				const arrow = element.arrow === undefined ? 'end' : element.arrow;
				if (arrow === 'end' || arrow === 'both') out.push(arrowHead(mapped[1], mapped[0], style));
				if (arrow === 'start' || arrow === 'both') out.push(arrowHead(mapped[0], mapped[1], style));
			}
			return;
		}
		case 'arrow': {
			// 显式箭头：末端三
			const from = resolvePointReference(element.from, context);
			const to = resolvePointReference(element.to, context);
			const mapped = [from, to].map((point) => matApply(matrix, point));
			out.push({
				kind: 'stroke',
				rings: [mapped],
				style: { ...style, fill: 'none', stroke: style.stroke ?? '#111827', stroke_width: style.stroke_width ?? 1.6 },
			});
			out.push(arrowHead(mapped[1], mapped[0], style));
			return;
		}
		case 'angle': {
			const at = resolvePointReference(element.at ?? element.vertex, context);
			const from = resolvePointReference(element.from, context);
			const to = resolvePointReference(element.to, context);
			const radius = element.radius ?? 30;
			const startAngle = Math.atan2(from[1] - at[1], from[0] - at[0]);
			const endAngle = Math.atan2(to[1] - at[1], to[0] - at[0]);
			const mappedAt = matApply(matrix, at);
			if (element.right === true) {
				// 直角小方
				const size = radius * 0.55;
				const u = normalizePt(subPt(matApply(matrix, from), mappedAt));
				const v = normalizePt(subPt(matApply(matrix, to), mappedAt));
				const square = [
					[mappedAt[0] + u[0] * size, mappedAt[1] + u[1] * size],
					[mappedAt[0] + (u[0] + v[0]) * size, mappedAt[1] + (u[1] + v[1]) * size],
					[mappedAt[0] + v[0] * size, mappedAt[1] + v[1] * size],
				];
				out.push({ kind: 'stroke', rings: [square], style: { ...style, fill: 'none', stroke: style.stroke ?? '#111827', stroke_width: style.stroke_width ?? 1.4 } });
			} else {
				let delta = endAngle - startAngle;
				while (delta <= -Math.PI) delta += Math.PI * 2;
				while (delta > Math.PI) delta -= Math.PI * 2;
				const arcPoints = [];
				const steps = Math.max(8, Math.ceil(Math.abs(delta) / 0.08));
				for (let i = 0; i <= steps; i += 1) {
					const angle = startAngle + (delta * i) / steps;
					arcPoints.push([at[0] + Math.cos(angle) * radius, at[1] + Math.sin(angle) * radius]);
				}
				const mapped = arcPoints.map((point) => matApply(matrix, point));
				out.push({ kind: 'stroke', rings: [mapped], style: { ...style, fill: 'none', stroke: style.stroke ?? '#111827', stroke_width: style.stroke_width ?? 1.4 } });
			}
			if (element.label !== undefined) {
				const midAngle = startAngle + (endAngle - startAngle) / 2;
				const labelRadius = radius * 1.45;
				out.push({
					kind: 'text',
					at: matApply(matrix, [at[0] + Math.cos(midAngle) * labelRadius, at[1] + Math.sin(midAngle) * labelRadius]),
					text: String(element.label),
					size: element.label_size ?? 13,
					color: style.stroke ?? '#111827',
					anchor: 'middle',
					valign: 'middle',
					italic: true,
				});
			}
			return;
		}
		case 'dimension': {
			// 长度标注：两条端刻度 + 尺寸+ 数
			const a = resolvePointReference(element.from, context);
			const b = resolvePointReference(element.to, context);
			const offset = element.offset ?? 0;
			const direction = normalizePt(subPt(b, a));
			const normal = leftNormal(direction);
			const shift = [normal[0] * offset, normal[1] * offset];
			const p1 = [a[0] + shift[0], a[1] + shift[1]];
			const p2 = [b[0] + shift[0], b[1] + shift[1]];
			const tick = Math.max(Math.abs(offset) * 0.5, (distPt(a, b) || 1) * 0.04);
			const mappedLine = [p1, p2].map((point) => matApply(matrix, point));
			out.push({ kind: 'stroke', rings: [mappedLine], style: { ...style, fill: 'none', stroke: style.stroke ?? '#6b7280', stroke_width: style.stroke_width ?? 1.2 } });
			// 端刻度与尺寸线垂直（normal 方向），并从尺寸线向两侧各伸出一
			for (const point of mappedLine) {
				out.push({
					kind: 'stroke',
					rings: [[[point[0] - normal[0] * tick, point[1] - normal[1] * tick], [point[0] + normal[0] * tick, point[1] + normal[1] * tick]]],
					style: { ...style, fill: 'none', stroke: style.stroke ?? '#6b7280', stroke_width: style.stroke_width ?? 1.2 },
				});
			}
			if (element.label !== false) {
				const text = element.label ?? formatNumber(distPt(a, b), 2);
				const middle = matApply(matrix, [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2]);
				out.push({
					kind: 'text',
					at: [middle[0] + normal[0] * tick * 1.6, middle[1] + normal[1] * tick * 1.6],
					text: String(text),
					size: element.label_size ?? 12,
					color: style.stroke ?? '#6b7280',
					anchor: 'middle',
					valign: 'middle',
				});
			}
			return;
		}
		case 'group': {
			if (!Array.isArray(element.elements)) fail('group: "elements" must be an array');
			const groupStyle = { ...style };
			for (const child of element.elements) compileElement(child, context, matrix, out, { inherited: groupStyle });
			return;
		}
		default:
			break;
	}

	// 形状类元素（含布尔与偏移
	const isCurve = ['curve', 'parametric', 'polar'].includes(type);
	if (isCurve && element.fill === undefined && style.fill === undefined) {
		// 函数/参数/极坐标曲线默认是**弢曲线**：按描边画，而不是围成面填色
		// （否sin(x) 会被填成丢条奇怪的横带）
		const segments = resolveShapeGeometry(element, context) ?? [];
		const mapped = segments.map((segment) => segment.map((point) => matApply(matrix, point)));
		if (mapped.length === 0) fail(`${type}: the curve produced no drawable points`);
		out.push({
			kind: 'stroke',
			rings: mapped,
			style: { ...style, fill: 'none', stroke: style.stroke ?? '#111827', stroke_width: style.stroke_width ?? 1.6 },
		});
		return;
	}

	let rings = resolveShape(element, context);
	if (rings === undefined) fail(`unsupported element type "${type}"`);
	rings = applyMatrixToRings(rings, matrix);
	const styleForShape = { ...style };
	if (element.fill !== undefined) styleForShape.fill = element.fill;
	if (element.stroke !== undefined) styleForShape.stroke = element.stroke;
	if (element.fill_opacity !== undefined) styleForShape.fill_opacity = element.fill_opacity;
	if (element.stroke_width !== undefined) styleForShape.stroke_width = element.stroke_width;
	if (element.opacity !== undefined) styleForShape.opacity = element.opacity;
	// 填充规则既可以写在 style 里，也可以直接写在元素上（后者更顺手）
	if (element.fill_rule !== undefined) styleForShape.fill_rule = element.fill_rule;
	if (styleForShape.fill === undefined) styleForShape.fill = '#000000';
	out.push({ kind: 'shape', rings, style: styleForShape });

	if (element.label !== undefined && element.label !== null) {
		const box = rings.reduce((acc, ring) => {
			for (const [x, y] of ring) {
				if (acc === undefined) acc = { minX: x, minY: y, maxX: x, maxY: y };
				else {
					acc.minX = Math.min(acc.minX, x);
					acc.minY = Math.min(acc.minY, y);
					acc.maxX = Math.max(acc.maxX, x);
					acc.maxY = Math.max(acc.maxY, y);
				}
			}
			return acc;
		}, undefined);
		if (box !== undefined) {
			const offset = element.label_offset ?? [0, 0];
			out.push({
				kind: 'text',
				at: [(box.minX + box.maxX) / 2 + Number(offset[0] ?? 0), (box.minY + box.maxY) / 2 + Number(offset[1] ?? 0)],
				text: String(element.label),
				size: element.label_size ?? 13,
				color: styleForShape.stroke ?? '#111827',
				anchor: 'middle',
				valign: 'middle',
			});
		}
	}
}

function pointStyle(style) {
	return { fill: style.fill ?? '#111827', stroke: style.stroke, stroke_width: style.stroke_width };
}

function arrowHead(tip, tail, style) {
	const direction = normalizePt(subPt(tip, tail));
	const size = style.arrow_size ?? 9;
	const normal = leftNormal(direction);
	const base = [tip[0] - direction[0] * size, tip[1] - direction[1] * size];
	return {
		kind: 'shape',
		rings: [[tip, [base[0] + normal[0] * size * 0.42, base[1] + normal[1] * size * 0.42], [base[0] - normal[0] * size * 0.42, base[1] - normal[1] * size * 0.42]]],
		style: { fill: style.stroke ?? '#111827', stroke: 'none' },
	};
}

function resolvePointReference(value, context) {
	if (value === undefined) fail('a point reference is required here');
	if (typeof value === 'string') {
		const found = context.named.get(value);
		if (found === undefined) fail(`named point "${value}" is not defined (points must be declared before use)`);
		return found;
	}
	return parsePoint(value, context.vars, 'point');
}

/** 形状 环；处理 `shape` 引用、`boolean` `offset` */
function resolveShape(element, context) {
	// 曲线在面」的语境里（显式给了 fill）按闭合轮廓处理：玫瑰线、心形线这类
	// 自身闭合的曲线因此可以直接填色
	if (['curve', 'parametric', 'polar'].includes(element.type)) {
		const segments = resolveShapeGeometry(element, context) ?? [];
		return normalizeRings(segments);
	}
	const inline = resolveShapeGeometry(element, context);
	if (inline !== undefined) {
		let rings = normalizeRings(inline);
		rings = applyOffset(element, rings, context);
		return rings;
	}
	if (element.shape !== undefined) {
		const referenced = resolveShapeReference(element.shape, context);
		let rings = applyMatrixToRings(referenced, IDENTITY);
		rings = applyOffset(element, rings, context);
		return rings;
	}
	if (element.boolean !== undefined && element.elements !== undefined) {
		return applyBoolean(element, context);
	}
	if (element.elements !== undefined) {
		// boolean 的元素集合按并集处理
		const union = [];
		for (const child of element.elements) {
			const childRings = resolveShape(child, context);
			if (childRings !== undefined) union.push(...childRings);
		}
		return normalizeRings(union);
	}
	return undefined;
}

function applyOffset(element, rings, context) {
	const distance = element.offset;
	if (distance === undefined) return rings;
	const value = resolveNumber(distance, context.vars, 'offset');
	if (Math.abs(value) < 1e-12) return rings;
	return offsetRings(rings, value);
}

function resolveShapeReference(name, context) {
	if (typeof name === 'string') {
		const definition = context.shapes?.[name];
		if (definition === undefined) fail(`shape "${name}" is not defined in "shapes"`);
		return resolveShape(definition, context) ?? [];
	}
	if (typeof name === 'object' && name !== null) return resolveShape(name, context) ?? [];
	fail('"shape" must be a name or an inline shape definition');
}

function applyBoolean(element, context) {
	const children = element.elements;
	if (!Array.isArray(children) || children.length === 0) fail('"boolean" needs a non-empty "elements" list');
	const op = element.boolean;
	if (!['union', 'intersect', 'difference', 'xor'].includes(op)) {
		fail(`"boolean" must be union/intersect/difference/xor (got "${op}")`);
	}
	const resolved = [];
	for (const child of children) {
		const rings = resolveShape(child, context);
		if (rings === undefined) fail(`boolean operand of type "${child.type}" produces no geometry`);
		resolved.push(rings);
	}
	let accumulator = resolved[0];
	for (let i = 1; i < resolved.length; i += 1) {
		accumulator = booleanRings(accumulator, resolved[i], op);
	}
	return accumulator;
}
