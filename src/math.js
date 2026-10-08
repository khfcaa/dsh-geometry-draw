/**
 * 二维几何原语：点、矩阵、以及「数学坐标 → SVG 屏幕坐标」的统一变换。
 *
 * 本插件的坐标系约定（与用户的直觉、以及几何课本一致）：
 *   - 画布是数学坐标：x 向右、y 向上；`xRange`/`yRange` 描述可视窗口。
 *   - 编译阶段先在数学坐标里完成全部几何运算（布尔、偏移、展平、对称），
 *     最后一次性把路径数据写成屏幕坐标（SVG 的 y 向下）。
 *
 * 之所以把翻转放在最后而不是用一个 `scale(1,-1)` 的组：翻转组会让文字上下颠倒、
 * 也会让圆弧的 sweep 方向反掉，是两个反复出错的坑。这里只在输出时做一次仿射。
 */

export const EPS = 1e-9;

/** 点：[x, y] */
export const pt = (x, y) => [x, y];
export const addPt = (a, b) => [a[0] + b[0], a[1] + b[1]];
export const subPt = (a, b) => [a[0] - b[0], a[1] - b[1]];
export const scalePt = (a, k) => [a[0] * k, a[1] * k];
export const dotPt = (a, b) => a[0] * b[0] + a[1] * b[1];
/** 二维叉积的 z 分量（有向面积的符号来源） */
export const crossPt = (a, b) => a[0] * b[1] - a[1] * b[0];
export const normPt = (a) => Math.hypot(a[0], a[1]);
export const distPt = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
export const lerpPt = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

export function normalizePt(a) {
	const n = normPt(a);
	if (n < EPS) return [0, 0];
	return [a[0] / n, a[1] / n];
}

/**
 * 方向向量的法线：把 `a` 顺时针旋转 90°（在数学坐标里等价于「右法线」）。
 *
 * 数学坐标（y 向上）下 (1,0) 旋转后得 (0,-1)，所以分量写成 `(dy, -dx)`。
 * 名字沿用几何库惯例（leftNormal），但请记住它的实际朝向是**右**——本插件里
 * 「环的内部在左、外部在右」的推理都依赖这个约定；改这个函数会让布尔运算的
 * 探针方向与偏移的外法线方向同时失效。
 */
export const leftNormal = (a) => [a[1], -a[0]];

// ---------------------------------------------------------------- 矩阵

/** 仿射矩阵 [a, b, c, d, e, f]，语义与 SVG `matrix(a,b,c,d,e,f)` 相同。 */
export const IDENTITY = [1, 0, 0, 1, 0, 0];

export function matMul(m, n) {
	return [
		m[0] * n[0] + m[2] * n[1],
		m[1] * n[0] + m[3] * n[1],
		m[0] * n[2] + m[2] * n[3],
		m[1] * n[2] + m[3] * n[3],
		m[0] * n[4] + m[2] * n[5] + m[4],
		m[1] * n[4] + m[3] * n[5] + m[5],
	];
}

export function matApply(m, p) {
	return [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];
}

/** 只对方向向量施加线性部分（不含平移） */
export function matApplyVector(m, v) {
	return [m[0] * v[0] + m[2] * v[1], m[1] * v[0] + m[3] * v[1]];
}

export function matTranslate(tx, ty) {
	return [1, 0, 0, 1, tx, ty];
}

export function matScale(sx, sy) {
	return [sx, 0, 0, sy, 0, 0];
}

/** 逆时针旋转 deg 度 */
export function matRotate(deg) {
	const r = (deg * Math.PI) / 180;
	const c = Math.cos(r);
	const s = Math.sin(r);
	return [c, s, -s, c, 0, 0];
}

/**
 * 关于直线 `through`（过 p、方向 dir）的镜像。
 * 用 Householder 形式构造，方向无需归一化。
 */
export function matMirror(p, dir) {
	const [dx, dy] = normalizePt(dir);
	const a = dx * dx - dy * dy;
	const b = 2 * dx * dy;
	const m = [a, b, b, -a, 0, 0];
	// 先平移到 p，镜像，再平移回去：(T(p) · M · T(-p))
	return matMul(matTranslate(p[0], p[1]), matMul(m, matTranslate(-p[0], -p[1])));
}

export function matDet(m) {
	return m[0] * m[3] - m[1] * m[2];
}

/** 关于 x 轴的镜像（y → -y） */
export const matFlipY = () => matScale(1, -1);

/** 关于 y 轴的镜像（x → -x） */
export const matFlipX = () => matScale(-1, 1);

// ---------------------------------------------------------------- 多边形工具

/** 有向面积（正 = 逆时针，在数学坐标里） */
export function signedArea(points) {
	let sum = 0;
	for (let i = 0; i < points.length; i += 1) {
		const a = points[i];
		const b = points[(i + 1) % points.length];
		sum += a[0] * b[1] - b[0] * a[1];
	}
	return sum / 2;
}

export function polygonBounds(points) {
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const [x, y] of points) {
		if (x < minX) minX = x;
		if (y < minY) minY = y;
		if (x > maxX) maxX = x;
		if (y > maxY) maxY = y;
	}
	return { minX, minY, maxX, maxY };
}

export function boundsUnion(a, b) {
	if (a === undefined) return b;
	if (b === undefined) return a;
	return {
		minX: Math.min(a.minX, b.minX),
		minY: Math.min(a.minY, b.minY),
		maxX: Math.max(a.maxX, b.maxX),
		maxY: Math.max(a.maxY, b.maxY),
	};
}

export function boundsIntersect(a, b) {
	if (a === undefined || b === undefined) return undefined;
	const r = {
		minX: Math.max(a.minX, b.minX),
		minY: Math.max(a.minY, b.minY),
		maxX: Math.min(a.maxX, b.maxX),
		maxY: Math.min(a.maxY, b.maxY),
	};
	if (r.minX > r.maxX || r.minY > r.maxY) return undefined;
	return r;
}

export function boundsOverlap(a, b) {
	return boundsIntersect(a, b) !== undefined;
}

export function boundsContains(outer, inner) {
	return (
		inner.minX >= outer.minX - EPS &&
		inner.maxX <= outer.maxX + EPS &&
		inner.minY >= outer.minY - EPS &&
		inner.maxY <= outer.maxY + EPS
	);
}

export function boundsCenter(b) {
	return [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2];
}

/**
 * 射线法判断点是否在多边形内部（奇偶规则）。
 * 自交轮廓也按奇偶处理，与 SVG 的 `fill-rule="evenodd"` 一致。
 */
export function pointInPolygon(p, points) {
	let inside = false;
	for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
		const a = points[i];
		const b = points[j];
		if (a[1] > p[1] !== b[1] > p[1]) {
			const x = a[0] + ((p[1] - a[1]) * (b[0] - a[0])) / (b[1] - a[1]);
			if (p[0] < x) inside = !inside;
		}
	}
	return inside;
}

/** 点到线段的最近点参数 t ∈ [0,1] 与距离 */
export function closestOnSegment(p, a, b) {
	const ab = subPt(b, a);
	const len2 = dotPt(ab, ab);
	if (len2 < EPS) return { t: 0, point: a, distance: distPt(p, a) };
	let t = dotPt(subPt(p, a), ab) / len2;
	t = Math.min(1, Math.max(0, t));
	const point = lerpPt(a, b, t);
	return { t, point, distance: distPt(p, point) };
}

/** 一组轮廓的整体包围盒 */
export function contoursBounds(contours) {
	return contours.reduce((acc, c) => boundsUnion(acc, polygonBounds(c)), undefined);
}

/** 去掉连续重复点与末尾闭合点 */
export function dedupe(points, tolerance = 1e-7) {
	const out = [];
	for (const p of points) {
		const last = out[out.length - 1];
		if (last === undefined || distPt(last, p) > tolerance) out.push(p);
	}
	while (out.length > 1 && distPt(out[0], out[out.length - 1]) <= tolerance) out.pop();
	return out;
}

// ---------------------------------------------------------------- 数字格式化

export function formatNumber(value, maxDecimals = 4) {
	if (!Number.isFinite(value)) return '0';
	const rounded = Number(value.toFixed(maxDecimals));
	if (Object.is(rounded, -0)) return '0';
	return String(rounded);
}
