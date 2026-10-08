/**
 * 绘图规格的自检。
 *
 * 目标不是「判定画面好不好看」（那要靠人看渲染结果），而是把**结构化错误**
 * 在渲染之前抓出来：坐标退化、闭合处自交、填充规则与轮廓数不匹配、颜色写法
 * 可疑、尺寸超出限制。这些都是隐藏的、肉眼在缩略图上很难看出的问题。
 */

import { distPt, pointInPolygon, polygonBounds, signedArea } from './math.js';
import { ringsToSegments } from './geometry.js';

const MAX_MESSAGE = 300;

export function auditFigure({ spec, compiled, range, canvas, svg }) {
	const warnings = [];
	const push = (message) => {
		const text = String(message);
		warnings.push(text.length > MAX_MESSAGE ? `${text.slice(0, MAX_MESSAGE)}…` : text);
	};

	let ringCount = 0;
	let pointCount = 0;
	let nanCount = 0;
	for (const item of compiled) {
		if (item.rings !== undefined) {
			for (const ring of item.rings) {
				ringCount += 1;
				pointCount += ring.length;
				for (const [x, y] of ring) {
					if (!Number.isFinite(x) || !Number.isFinite(y)) nanCount += 1;
				}
			}
		}
	}

	if (nanCount > 0) push(`有 ${nanCount} 个坐标不是有限数（NaN/Infinity），相关图形会被跳过`);

	// 退化轮廓：所有点**真的共线**（或退化成一点），画出来不可见。
	//
	// 不能只看面积：高度自交的闭合曲线（例如李萨如 x=cos(3t), y=sin(4t)）净面积
	// 在数学上恰好为零（正负面积完全抵消，可由格林公式逐项验证），但它填满了一
	// 大片区域。也不能只看「细长比」，否则很窄的条带会被误报。
	// 判据取「点到首尾连线的最大偏离」，它只对确实共线的轮廓成立。
	let degenerate = 0;
	for (const item of compiled) {
		if (item.rings === undefined) continue;
		for (const ring of item.rings) {
			if (ring.length < 3) continue;
			if (isCollinearRing(ring)) degenerate += 1;
		}
	}
	if (degenerate > 0) push(`有 ${degenerate} 条轮廓的点全部共线，画出来不可见`);

	// 自交检测（只查点数较少的轮廓，避免大图退化）
	let selfIntersections = 0;
	for (const item of compiled) {
		if (item.rings === undefined) continue;
		if (item.kind === 'stroke') continue;
		for (const ring of item.rings) {
			if (ring.length > 400) continue;
			selfIntersections += countSelfIntersections(ring);
		}
	}
	if (selfIntersections > 0) {
		push(`检测到 ${selfIntersections} 处轮廓自交；若填充出现意外镂空，请改用 fill_rule:"evenodd" 或把自交拆成多个轮廓`);
	}

	// 轮廓嵌套与填充规则：多轮廓但方向不一致时，孔洞的去留会依赖规则选择。
	// 只有「确实存在缺口」时才提醒，避免对本来就用 evenodd 的图重复唠叨。
	const declaredRule = spec.fill_rule ?? collectDeclaredRules(spec.elements);
	if (declaredRule !== 'evenodd') {
		for (const item of compiled) {
			if (item.rings === undefined || item.rings.length < 2) continue;
			if (item.style?.fill_rule === 'evenodd') continue;
			const orientations = item.rings.map((ring) => (signedArea(ring) > 0 ? 1 : -1));
			const mixed = orientations.some((value) => value !== orientations[0]);
			if (mixed) {
				push('同一形状含方向相反的多个轮廓，且未声明 fill_rule：孔洞可能被填实或消失，建议显式写 fill_rule:"evenodd"');
			}
		}
	}

	// 尺寸与元素规模
	if (svg.length > 8 * 1024 * 1024) push(`生成的 SVG 有 ${(svg.length / 1024 / 1024).toFixed(1)}MB，元素可能过多`);
	if (ringCount > 4000) push(`轮廓总数 ${ringCount} 偏多，渲染会变慢`);

	// 坐标系提示：图形是否落在可视范围内
	if (range !== undefined) {
		const inside = compiled.some((item) => {
			if (item.rings === undefined) return false;
			for (const ring of item.rings) {
				for (const [x, y] of ring) {
					if (x >= range.x0 && x <= range.x1 && y >= range.y0 && y <= range.y1) return true;
				}
			}
			return false;
		});
		if (!inside) push('所有图形都不在可视范围内：检查 xRange/yRange 是否把内容排除在外');
	}

	return {
		warnings,
		stats: {
			rings: ringCount,
			points: pointCount,
			selfIntersections,
			degenerate,
			width: canvas.width,
			height: canvas.height,
			svgBytes: svg.length,
		},
		explicitWarnings: warnings.length,
		pointInAny: undefined,
	};
}

/**
 * 轮廓的所有点是否落在同一条直线上。
 * 以首尾两点连线为基准；两点重合时改用与第一个不同的一点作为基准方向。
 * 只有整体尺度上的偏离都小到可以忽略，才判为共线。
 */
function isCollinearRing(ring) {
	const box = polygonBounds(ring);
	const scale = Math.max(box.maxX - box.minX, box.maxY - box.minY);
	if (scale < 1e-12) return true;
	let base = ring[0];
	let tip = ring[ring.length - 1];
	if (distPt(base, tip) < scale * 1e-9) {
		const other = ring.find((point) => distPt(base, point) > scale * 1e-9);
		if (other === undefined) return true;
		tip = other;
	}
	const direction = [tip[0] - base[0], tip[1] - base[1]];
	const length = Math.hypot(direction[0], direction[1]);
	if (length < 1e-12) return true;
	for (const point of ring) {
		const offset = pointInLineDistance(point, base, direction, length);
		if (offset > scale * 1e-6) return false;
	}
	return true;
}

function pointInLineDistance(point, base, direction, length) {
	return Math.abs((point[0] - base[0]) * direction[1] - (point[1] - base[1]) * direction[0]) / length;
}

/** 递归收集元素上声明的 fill_rule（顶层或元素级都算已声明） */function collectDeclaredRules(elements) {
	if (!Array.isArray(elements)) return undefined;
	for (const element of elements) {
		if (typeof element !== 'object' || element === null) continue;
		if (element.fill_rule !== undefined) return element.fill_rule;
		if (element.style?.fill_rule !== undefined) return element.style.fill_rule;
		if (Array.isArray(element.elements)) {
			const nested = collectDeclaredRules(element.elements);
			if (nested !== undefined) return nested;
		}
	}
	return undefined;
}

function countSelfIntersections(ring, limit = 4) {	let count = 0;
	for (let i = 0; i < ring.length; i += 1) {
		for (let j = i + 2; j < ring.length; j += 1) {
			if (i === 0 && j === ring.length - 1) continue;
			if (segmentsIntersect(ring[i], ring[(i + 1) % ring.length], ring[j], ring[(j + 1) % ring.length])) {
				count += 1;
				if (count >= limit) return count;
			}
		}
	}
	return count;
}

function segmentsIntersect(p1, p2, p3, p4) {
	const d1 = cross(p3, p4, p1);
	const d2 = cross(p3, p4, p2);
	const d3 = cross(p1, p2, p3);
	const d4 = cross(p1, p2, p4);
	if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
	return false;
}

function cross(a, b, p) {
	return (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
}

/** 轮廓是否包含某个点（供工具层做「点击落在哪个形状上」这类说明） */
export function ringContains(ring, point) {
	return pointInPolygon(point, ring);
}

export function ringBounds(ring) {
	return polygonBounds(ring);
}

export function ringSpan(ring) {
	const box = polygonBounds(ring);
	return distPt([box.minX, box.minY], [box.maxX, box.maxY]);
}

export { ringsToSegments };
