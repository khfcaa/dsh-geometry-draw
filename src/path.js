/**
 * SVG 路径数据的解析、展平与序列化。
 *
 * 展平后的表示是本插件的「通用货币」：布尔运算、偏移、自检都吃
 * 「一组轮廓，每个轮廓是一串折线点」，因此所有曲线在这一层被离散化。
 * 离散精度按屏幕像素给出（`tolerance`），由调用方从缩放比例换算。
 */

import { EPS, addPt, distPt, formatNumber, lerpPt, subPt } from './math.js';

// ---------------------------------------------------------------- 路径解析

const PATH_TOKEN = /([MmZzLlHhVvCcSsQqTtAa])|(-?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?)/g;

const COMMAND_ARITY = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };

/** 把路径文本切成 `{ command, params }` 序列（保留相对/绝对与重复参数组） */
export function tokenizePath(d) {
	const tokens = [];
	PATH_TOKEN.lastIndex = 0;
	let m;
	while ((m = PATH_TOKEN.exec(d)) !== null) {
		if (m[1] !== undefined) tokens.push({ kind: 'command', value: m[1] });
		else tokens.push({ kind: 'number', value: Number(m[2]) });
	}
	const segments = [];
	let i = 0;
	while (i < tokens.length) {
		const token = tokens[i];
		if (token.kind !== 'command') {
			throw new Error(`path data: expected a command near token ${i} ("${d.slice(0, 40)}…")`);
		}
		const upper = token.value.toUpperCase();
		const arity = COMMAND_ARITY[upper];
		const relative = token.value !== upper;
		i += 1;
		if (arity === 0) {
			segments.push({ command: upper, relative, params: [] });
			continue;
		}
		// 一个命令后可跟多组参数（隐式重复），M 的后续组按 L 处理
		let first = true;
		while (i < tokens.length && tokens[i].kind === 'number') {
			const params = [];
			for (let k = 0; k < arity; k += 1) {
				const next = tokens[i + k];
				if (next === undefined || next.kind !== 'number') {
					throw new Error(`path data: command "${token.value}" expects ${arity} numbers`);
				}
				params.push(next.value);
			}
			i += arity;
			const command = upper === 'M' && !first ? 'L' : upper;
			segments.push({ command, relative, params });
			first = false;
		}
		if (first) throw new Error(`path data: command "${token.value}" is missing its numbers`);
	}
	return segments;
}

// ---------------------------------------------------------------- 弧 → 三次贝塞尔

/** 把一段椭圆弧转成不超过 90° 的三次贝塞尔段数组：`[{ c1, c2, end }]` */
export function arcToCubics(start, rx, ry, xAxisRotationDeg, largeArc, sweep, end) {
	let [x1, y1] = start;
	let [x2, y2] = end;
	if (distPt(start, end) < EPS) return [];
	rx = Math.abs(rx);
	ry = Math.abs(ry);
	if (rx < EPS || ry < EPS) return [{ c1: start, c2: end, end }];

	const phi = (xAxisRotationDeg * Math.PI) / 180;
	const cosPhi = Math.cos(phi);
	const sinPhi = Math.sin(phi);

	// 端点变换到椭圆主轴坐标系
	const dx = (x1 - x2) / 2;
	const dy = (y1 - y2) / 2;
	const x1p = cosPhi * dx + sinPhi * dy;
	const y1p = -sinPhi * dx + cosPhi * dy;

	// 半径不足时按规范等比放大
	const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
	if (lambda > 1) {
		const s = Math.sqrt(lambda);
		rx *= s;
		ry *= s;
	}

	const sign = largeArc === sweep ? -1 : 1;
	const numerator = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
	const denominator = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
	const factor = sign * Math.sqrt(Math.max(0, numerator / denominator));
	const cxp = (factor * rx * y1p) / ry;
	const cyp = (-factor * ry * x1p) / rx;
	const cx = cosPhi * cxp - sinPhi * cyp + (x1 + x2) / 2;
	const cy = sinPhi * cxp + cosPhi * cyp + (y1 + y2) / 2;

	const angleOf = (ux, uy) => Math.atan2(uy, ux);
	const startAngle = angleOf((x1p - cxp) / rx, (y1p - cyp) / ry);
	const endAngle = angleOf((-x1p - cxp) / rx, (-y1p - cyp) / ry);
	let delta = endAngle - startAngle;
	if (!sweep && delta > 0) delta -= 2 * Math.PI;
	if (sweep && delta < 0) delta += 2 * Math.PI;

	const count = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 2)));
	const step = delta / count;
	// 每段用标准的三次贝塞尔近似圆弧
	const alpha = (4 / 3) * Math.tan(step / 4);

	const toWorld = (ex, ey) => [cosPhi * ex - sinPhi * ey + cx, sinPhi * ex + cosPhi * ey + cy];
	const derivative = (t) => [
		cosPhi * (-rx * Math.sin(t)) - sinPhi * (ry * Math.cos(t)),
		sinPhi * (-rx * Math.sin(t)) + cosPhi * (ry * Math.cos(t)),
	];

	const cubics = [];
	for (let i = 0; i < count; i += 1) {
		const t0 = startAngle + i * step;
		const t1 = t0 + step;
		const p0 = toWorld(rx * Math.cos(t0), ry * Math.sin(t0));
		const p1 = toWorld(rx * Math.cos(t1), ry * Math.sin(t1));
		const d0 = derivative(t0);
		const d1 = derivative(t1);
		cubics.push({
			c1: [p0[0] + alpha * d0[0], p0[1] + alpha * d0[1]],
			c2: [p1[0] - alpha * d1[0], p1[1] - alpha * d1[1]],
			end: p1,
		});
	}
	// 数值上把最后一点钉到请求的终点
	if (cubics.length > 0) cubics[cubics.length - 1] = { ...cubics[cubics.length - 1], end: [x2, y2] };
	return cubics;
}

// ---------------------------------------------------------------- 展平

function flattenCubic(out, p0, c1, c2, p1, tolerance) {
	// 以控制点到弦的最大距离估算细分段数
	const d1 = pointLineDistance(c1, p0, p1);
	const d2 = pointLineDistance(c2, p0, p1);
	const d = Math.max(d1, d2);
	let count = 1;
	if (d > tolerance) {
		// 三次贝塞尔的最大偏差约与段数平方成反比
		count = Math.min(256, Math.max(2, Math.ceil(Math.sqrt((d * 3) / tolerance))));
	}
	for (let i = 1; i <= count; i += 1) {
		out.push(cubicAt(p0, c1, c2, p1, i / count));
	}
}

function pointLineDistance(p, a, b) {
	const ab = subPt(b, a);
	const len = Math.hypot(ab[0], ab[1]);
	if (len < EPS) return distPt(p, a);
	return Math.abs((p[0] - a[0]) * ab[1] - (p[1] - a[1]) * ab[0]) / len;
}

export function cubicAt(p0, c1, c2, p1, t) {
	const mt = 1 - t;
	const a = mt * mt * mt;
	const b = 3 * mt * mt * t;
	const c = 3 * mt * t * t;
	const d = t * t * t;
	return [
		a * p0[0] + b * c1[0] + c * c2[0] + d * p1[0],
		a * p0[1] + b * c1[1] + c * c2[1] + d * p1[1],
	];
}

/**
 * 把路径文本展开成一串子路径（每个是闭合或开口的折线点数组）。
 * 闭合子路径会重复首点作为末点，方便后续按「环」处理。
 */
export function flattenPathData(d, tolerance = 0.25) {
	const segments = tokenizePath(d);
	const subpaths = [];
	let current = [];
	let cursor = [0, 0];
	let subpathStart = [0, 0];
	let lastCubicControl = null;
	let lastQuadControl = null;
	let closed = false;

	const push = (p) => {
		current.push(p);
	};
	const finish = () => {
		if (current.length > 0) {
			const points = current.length > 1 ? current : [current[0], current[0]];
			subpaths.push({ points, closed });
		}
		current = [];
		closed = false;
	};

	for (const segment of segments) {
		const { command, relative, params } = segment;
		const rel = (p) => (relative ? addPt(cursor, p) : p);
		switch (command) {
			case 'M': {
				finish();
				cursor = rel([params[0], params[1]]);
				subpathStart = cursor;
				push(cursor);
				lastCubicControl = null;
				lastQuadControl = null;
				break;
			}
			case 'L': {
				cursor = rel([params[0], params[1]]);
				push(cursor);
				lastCubicControl = null;
				lastQuadControl = null;
				break;
			}
			case 'H': {
				cursor = relative ? [cursor[0] + params[0], cursor[1]] : [params[0], cursor[1]];
				push(cursor);
				lastCubicControl = null;
				lastQuadControl = null;
				break;
			}
			case 'V': {
				cursor = relative ? [cursor[0], cursor[1] + params[0]] : [cursor[0], params[0]];
				push(cursor);
				lastCubicControl = null;
				lastQuadControl = null;
				break;
			}
			case 'C': {
				const c1 = rel([params[0], params[1]]);
				const c2 = rel([params[2], params[3]]);
				const end = rel([params[4], params[5]]);
				flattenCubic(current, cursor, c1, c2, end, tolerance);
				cursor = end;
				lastCubicControl = c2;
				lastQuadControl = null;
				break;
			}
			case 'S': {
				const c1 = lastCubicControl === null ? cursor : [2 * cursor[0] - lastCubicControl[0], 2 * cursor[1] - lastCubicControl[1]];
				const c2 = rel([params[0], params[1]]);
				const end = rel([params[2], params[3]]);
				flattenCubic(current, cursor, c1, c2, end, tolerance);
				cursor = end;
				lastCubicControl = c2;
				lastQuadControl = null;
				break;
			}
			case 'Q': {
				const c = rel([params[0], params[1]]);
				const end = rel([params[2], params[3]]);
				const [c1, c2] = quadToCubic(cursor, c, end);
				flattenCubic(current, cursor, c1, c2, end, tolerance);
				cursor = end;
				lastQuadControl = c;
				lastCubicControl = null;
				break;
			}
			case 'T': {
				const c = lastQuadControl === null ? cursor : [2 * cursor[0] - lastQuadControl[0], 2 * cursor[1] - lastQuadControl[1]];
				const end = rel([params[0], params[1]]);
				const [c1, c2] = quadToCubic(cursor, c, end);
				flattenCubic(current, cursor, c1, c2, end, tolerance);
				cursor = end;
				lastQuadControl = c;
				lastCubicControl = null;
				break;
			}
			case 'A': {
				const end = rel([params[5], params[6]]);
				const cubics = arcToCubics(cursor, params[0], params[1], params[2], params[3] === 1, params[4] === 1, end);
				for (const cubic of cubics) flattenCubic(current, cursor, cubic.c1, cubic.c2, cubic.end, tolerance);
				if (cubics.length > 0) cursor = end;
				lastCubicControl = null;
				lastQuadControl = null;
				break;
			}
			case 'Z': {
				if (current.length > 1) {
					const first = current[0];
					if (distPt(current[current.length - 1], first) > 1e-9) push(first);
					closed = true;
				}
				cursor = subpathStart;
				lastCubicControl = null;
				lastQuadControl = null;
				finish();
				break;
			}
			default:
				throw new Error(`path data: unsupported command "${command}"`);
		}
	}
	finish();
	return subpaths;
}

function quadToCubic(p0, c, p1) {
	const c1 = lerpPt(p0, c, 2 / 3);
	const c2 = lerpPt(p1, c, 2 / 3);
	return [c1, c2];
}

// ---------------------------------------------------------------- 序列化

/** 由一组轮廓生成 `d` 属性；每个轮廓都是闭合环。 */
export function contoursToPathData(contours, decimals = 3) {
	const parts = [];
	for (const points of contours) {
		if (points.length < 3) continue;
		const body = points
			.slice(0, points.length)
			.map((p, index) => `${index === 0 ? 'M' : 'L'}${formatNumber(p[0], decimals)} ${formatNumber(p[1], decimals)}`)
			.join(' ');
		parts.push(`${body} Z`);
	}
	return parts.join(' ');
}

/** 折线（可能是开口的）→ `d`，用于描边路径 */
export function polylineToPathData(points, decimals = 3) {
	return points
		.map((p, index) => `${index === 0 ? 'M' : 'L'}${formatNumber(p[0], decimals)} ${formatNumber(p[1], decimals)}`)
		.join(' ');
}

/**
 * 把（数学坐标的）路径数据整体仿射到目标坐标。
 * 只做一次，且在这里处理圆弧的 sweep/large-arc 翻转，避免翻转组带来的文字倒置问题。
 */
export function transformPathData(d, matrix, tolerance = 0.25) {
	const subpaths = flattenPathData(d, tolerance);
	const out = [];
	for (const { points, closed } of subpaths) {
		const mapped = points.map((p) => applyMatrix(matrix, p));
		if (closed && mapped.length > 2) {
			const first = mapped[0];
			const last = mapped[mapped.length - 1];
			if (distPt(first, last) > 1e-9) mapped.push(first);
		}
		out.push(mapped);
	}
	return out;
}

function applyMatrix(m, p) {
	return [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];
}
