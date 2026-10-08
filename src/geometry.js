/**
 * 多边形布尔运算与轮廓偏移——本插件的几何内核。
 *
 * 输入输出统一为「一组环（ring）」：每个环是一串点，首尾**不**重复，
 * 隐含闭合。一个形状的多个环按**奇偶规则**叠加解读（外环 + 孔洞），
 * 与 SVG 的 `fill-rule="evenodd"` 一致，因此结果可以直接塞进一个 `<path>`。
 *
 * 算法：把两个操作数的边两两求交并按交点切分，再对每条子段的中点做
 * 内外判定（奇偶射线法），按运算类型决定去留，最后把保留的有向子段
 * 缝合成环。切分后不会再有边相交，缝合因此是局部的、可判定的。
 */

import {
	EPS,
	closestOnSegment,
	crossPt,
	distPt,
	leftNormal,
	normalizePt,
	pointInPolygon,
	polygonBounds,
	signedArea,
	subPt,
} from './math.js';

const MERGE_TOLERANCE = 1e-7;

/**
 * 判定用的探针距离。
 *
 * 子段的中点落在**自己形状的边界上**（它就是那条边的一段），因此「中点是否在
 * 形状内」在浮点层面是毫无意义的抛硬币。真正的判据是子段的**外侧**：
 * 沿远离本形状的方向挪一点点，再看那个点在另一个形状的内外。
 * 1e-6 远大于浮点噪声（约 1e-9）、又远小于任何有意义的图形尺寸。
 */
const PROBE = 1e-6;

// ---------------------------------------------------------------- 基础

/** 确保每个环首尾不重复 */
function openRing(points) {
	if (points.length > 1 && distPt(points[0], points[points.length - 1]) < 1e-9) {
		return points.slice(0, -1);
	}
	return points.slice();
}

function cleanRing(points) {
	const out = [];
	for (const p of openRing(points)) {
		const last = out[out.length - 1];
		if (last === undefined || distPt(last, p) > 1e-12) out.push(p);
	}
	if (out.length > 1 && distPt(out[0], out[out.length - 1]) < 1e-12) out.pop();
	return out;
}

/** 去掉环里的重复点，丢弃退化环 */
export function normalizeRings(rings) {
	const out = [];
	for (const ring of rings) {
		const cleaned = cleanRing(ring);
		if (cleaned.length >= 3) out.push(cleaned);
	}
	return out;
}

export function ringsToSegments(rings) {
	const segments = [];
	for (const ring of rings) {
		for (let i = 0; i < ring.length; i += 1) {
			const a = ring[i];
			const b = ring[(i + 1) % ring.length];
			if (distPt(a, b) > 1e-12) segments.push({ a, b });
		}
	}
	return segments;
}

/** 点在整组环内的奇偶判定 */
export function ringsContainPoint(rings, p) {
	let inside = false;
	for (const ring of rings) {
		if (pointInPolygon(p, ring)) inside = !inside;
	}
	return inside;
}

// ---------------------------------------------------------------- 线段求交

/**
 * 求两线段的唯一交点；平行/共线/端点接触返回 null（端点在切分中天然是断点）。
 * 相交判定使用相对容差，避免长边上的浮点抖动造成的漏切。
 */
function segmentIntersection(p1, p2, p3, p4) {
	const r = subPt(p2, p1);
	const s = subPt(p4, p3);
	const denominator = crossPt(r, s);
	if (Math.abs(denominator) < 1e-14) return null;

	const qp = subPt(p3, p1);
	const t = crossPt(qp, s) / denominator;
	const u = crossPt(qp, r) / denominator;
	const scale = 1e-9;
	if (t < -scale || t > 1 + scale || u < -scale || u > 1 + scale) return null;
	return { t: Math.min(1, Math.max(0, t)), u: Math.min(1, Math.max(0, u)) };
}

/**
 * 把坐标吸附到一个精细网格。
 *
 * 缝合靠「终点的 key == 下一条边的起点的 key」来建立邻接，而交点坐标由两次
 * 不同的参数插值算出，末位可能有 1e-16 级别的差异；若 key 直接取原始坐标，
 * 同一个顶点会算出两个 key，出边就找不到了（症状：缝合在角点处断链，整块
 * 区域被丢掉或绕成错误的环）。吸附到 1e-9 网格后，端点身份是确定的。
 */
function snapPoint(p) {
	return [Math.round(p[0] * 1e9) / 1e9, Math.round(p[1] * 1e9) / 1e9];
}

/**
 * 把 `segments` 的每条边在它与 `cutters` 的交点处切开。
 *
 * 关键点：交点参数 `t` 是**相对于自己的边**定义的，只有来自另一组线段时才有
 * 意义（若拿另一条边的 `t` 去切自己，就会切在毫不相干的位置）。因此这里严格
 * 分「被切组」和「切割组」，而不是把所有交点混在一起。
 *
 * 返回的子段仍带方向（a → b），供后续按运算类型筛选。
 */
function splitAtIntersections(segments, cutters) {
	const params = segments.map(() => [0, 1]);
	for (let i = 0; i < segments.length; i += 1) {
		for (let j = 0; j < cutters.length; j += 1) {
			const hit = segmentIntersection(segments[i].a, segments[i].b, cutters[j].a, cutters[j].b);
			if (hit === null) continue;
			params[i].push(hit.t);
		}
	}

	const out = [];
	for (let i = 0; i < segments.length; i += 1) {
		const { a, b } = segments[i];
		const sorted = params[i].slice().sort((x, y) => x - y);
		const unique = [];
		for (const t of sorted) {
			if (unique.length === 0 || Math.abs(t - unique[unique.length - 1]) > 1e-12) unique.push(t);
		}
		for (let k = 0; k + 1 < unique.length; k += 1) {
			const t0 = unique[k];
			const t1 = unique[k + 1];
			if (t1 - t0 < 1e-12) continue;
			const p0 = snapPoint([a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0]);
			const p1 = snapPoint([a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1]);
			if (distPt(p0, p1) < 1e-12) continue;
			out.push({ a: p0, b: p1 });
		}
	}
	return out;
}

// ---------------------------------------------------------------- 缝合

const GRID = 1e6;

function keyOf(p) {
	return `${Math.round(p[0] * GRID)}:${Math.round(p[1] * GRID)}`;
}

/**
 * 用「最右转」策略把有向子段缝合成环。
 *
 * 选最右转（而非最左转）的原因：输入环在数学坐标里多为逆时针（面积为正），
 * 有向边沿逆时针行进时形状始终在左手边；在该顶点处选择**顺时针方向最靠后**
 * 的出边，等价于贴着当前形状的边界继续走，因此得到的是最小面（正确的环），
 * 而不是把整块外轮廓或空腔一起圈进来。
 */
function stitchRings(segments) {
	const outgoing = new Map();
	segments.forEach((segment, index) => {
		const key = keyOf(segment.a);
		const list = outgoing.get(key);
		if (list === undefined) outgoing.set(key, [index]);
		else list.push(index);
	});

	const outgoingByEnd = new Map();
	segments.forEach((segment, index) => {
		const key = keyOf(segment.b);
		const list = outgoingByEnd.get(key);
		if (list === undefined) outgoingByEnd.set(key, [index]);
		else list.push(index);
	});

	const used = new Array(segments.length).fill(false);
	const rings = [];

	for (let start = 0; start < segments.length; start += 1) {
		if (used[start]) continue;
		const ring = [];
		let current = start;
		let guard = 0;
		while (guard < segments.length * 4 + 16) {
			guard += 1;
			used[current] = true;
			const segment = segments[current];
			ring.push(segment.a);
			const candidates = outgoing.get(keyOf(segment.b)) ?? [];
			const alive = candidates.filter((index) => !used[index]);
			if (alive.length === 0) {
				// 回到起点或断链：若终点等于环起点则闭合成功
				if (ring.length >= 3 && distPt(segment.b, ring[0]) < 1e-6) {
					rings.push(ring);
				}
				break;
			}
			const incoming = normalizePt(subPt(segment.b, segment.a));
			let best = -1;
			let bestScore = -Infinity;
			for (const index of alive) {
				const next = segments[index];
				const direction = normalizePt(subPt(next.b, next.a));
				// 最右转 = 夹角（带符号）最小；用 atan2 保证跨 ±π 连续
				const turn = Math.atan2(crossPt(incoming, direction), incoming[0] * direction[0] + incoming[1] * direction[1]);
				const signed = turn <= 0 ? turn : turn - 2 * Math.PI;
				if (signed > bestScore) {
					bestScore = signed;
					best = index;
				}
			}
			if (best < 0) break;
			current = best;
			if (distPt(segments[current].a, ring[0]) < 1e-6) {
				used[current] = true;
				rings.push(ring);
				break;
			}
		}
	}
	return normalizeRings(rings);
}

// ---------------------------------------------------------------- 布尔运算

/**
 * 一条边段该不该留下，判据只有一条：**它是否真的分隔「结果内」与「结果外」**。
 *
 * 在边段两侧各取一个探针点（沿外侧、沿内侧），把两个点各自代入布尔函数；
 * 两侧归属不同 ⇒ 这条边是结果的边界 ⇒ 保留；两侧相同 ⇒ 它要么是被覆盖的
 * 内部边（两侧都在结果里），要么与结果无关（两侧都在结果外）⇒ 丢弃。
 *
 * 这个表述的好处是它与运算类型无关——加一种运算只需要加一个布尔函数，
 * 不必再纠结「A 的边和 B 的边规则不一样」。
 */
const RESULT_FN = {
	union: (inA, inB) => inA || inB,
	intersect: (inA, inB) => inA && inB,
	difference: (inA, inB) => inA && !inB,
	xor: (inA, inB) => inA !== inB,
};

/**
 * 两个形状（各为一组环）之间的布尔运算。
 * @param {number[][][]} ringsA
 * @param {number[][][]} ringsB
 * @param {'union'|'intersect'|'difference'|'xor'} op
 */
export function booleanRings(ringsA, ringsB, op) {
	// 输入先规范化方向（外环逆时针、孔洞顺时针），探针才可能判定「哪一侧是内侧」
	const A = orientRings(ringsA);
	const B = orientRings(ringsB);
	if (A.length === 0) {
		if (op === 'union' || op === 'xor') return B;
		return [];
	}
	if (B.length === 0) {
		if (op === 'union' || op === 'difference' || op === 'xor') return A;
		return [];
	}

	// 异或走「两次差集再求并」：A⊕B = (A−B) ∪ (B−A)。
	if (op === 'xor') return xorRings(A, B);

	const segmentsA = ringsToSegments(A);
	const segmentsB = ringsToSegments(B);
	const partsA = splitAtIntersections(segmentsA, segmentsB);
	const partsB = splitAtIntersections(segmentsB, segmentsA);

	const result = RESULT_FN[op];
	const kept = [];
	// 交点的浮点误差会留下极短子段，按长度过滤以免污染缝合
	const minLength = 1e-9;

	for (const [parts, ringsSelf] of [
		[partsA, A],
		[partsB, B],
	]) {
		for (const part of parts) {
			if (distPt(part.a, part.b) < minLength) continue;
			const direction = normalizePt(subPt(part.b, part.a));
			if (direction[0] === 0 && direction[1] === 0) continue;
			const normal = leftNormal(direction);

			// 两侧各取一个候选点，**用「哪一侧属于本形状」来认出内侧**：
			// 子段沿线都是本形状的边界，中点两侧必然一点在内、一点在外，因此
			// 不需要预先知道法线的朝向（这正是之前反复出错的地方——法线符号
			// 既受环的走向影响，又受 leftNormal 的实际朝向影响，两层符号很容易
			// 互相抵消成错误的结论）。
			const step = Math.max(PROBE, partLength(part) * 1e-3);
			const mid = [(part.a[0] + part.b[0]) / 2, (part.a[1] + part.b[1]) / 2];
			const candidateA = [mid[0] + normal[0] * step, mid[1] + normal[1] * step];
			const candidateB = [mid[0] - normal[0] * step, mid[1] - normal[1] * step];
			const candidateAInSelf = ringsContainPoint(ringsSelf, candidateA);
			const candidateBInSelf = ringsContainPoint(ringsSelf, candidateB);
			if (candidateAInSelf === candidateBInSelf) continue;

			const insidePoint = candidateAInSelf ? candidateA : candidateB;
			const outsidePoint = candidateAInSelf ? candidateB : candidateA;
			const insideInResult = result(ringsContainPoint(A, insidePoint), ringsContainPoint(B, insidePoint));
			const outsideInResult = result(ringsContainPoint(A, outsidePoint), ringsContainPoint(B, outsidePoint));
			// 两侧归属不同 ⇒ 这条边就是结果的边界
			if (insideInResult === outsideInResult) continue;

			// 统一朝向：让**结果区域恒定在行进方向的左侧**。
			//
			// 这一步是缝合能否闭合的关键。差集的边界由 A 的外边界与 B 的内边界拼成，
			// 而「B 在 A 内的那部分边界」在结果里必须反向走（它是孔洞/凹口的内沿）；
			// 若不统一，同一个顶点处会出现两条同向的边，缝合在那里必然断链
			// （症状：差集返回空数组）。反向的判据很简单：内侧不在结果里，就说明
			// 结果在右侧，于是把这条边颠倒过来。
			kept.push(insideInResult ? part : { a: part.b, b: part.a });
		}
	}

	if (kept.length === 0) return [];
	return orientRings(stitchRings(pruneCollinear(dedupeSegments(kept))));
}

/**
 * 异或：拆成两次差集再求并（A⊕B = (A−B) ∪ (B−A)）。
 *
 * 直接按边界筛选也能算，但异或的保留边同时来自两个方向相反的边界，缝合时
 * 方向混杂、在角点处容易「该断不断」；拆开之后每一步的边界方向都一致。
 */
function xorRings(A, B) {
	const left = booleanRings(A, B, 'difference');
	const right = booleanRings(B, A, 'difference');
	if (left.length === 0) return right;
	if (right.length === 0) return left;
	return booleanRings(left, right, 'union');
}

/**
 * 去掉「中间点」：两条相邻边段的共同端点若只是把一条直线切成两段
 * （方向完全一致），这个端点就不是真正的角点。
 *
 * 这一条是缝合正确性的关键。缝合时要在共享顶点处挑一条出边；如果一条直线上
 * 还残留着中间顶点，一个 180° 折返的走法就会成为候选，而它会把整块外轮廓
 * 圈进来（差集「切掉一角」的经典错法）。清掉共线的中间点后，所有转折都是
 * 真角点，选择才不再有歧义。
 */
function pruneCollinear(segments, tolerance = 1e-9) {
	const outgoing = new Map();
	segments.forEach((segment, index) => {
		const key = keyOf(segment.b);
		const list = outgoing.get(key);
		if (list === undefined) outgoing.set(key, [index]);
		else list.push(index);
	});

	// 先做完全的共线吸收：若 a→b 与 b→c 方向一致，合并成 a→c
	const used = new Array(segments.length).fill(false);
	const merged = [];
	for (let i = 0; i < segments.length; i += 1) {
		if (used[i]) continue;
		let current = segments[i];
		used[i] = true;
		let guard = 0;
		while (guard < segments.length + 1) {
			guard += 1;
			const candidates = (outgoing.get(keyOf(current.b)) ?? []).filter((index) => !used[index]);
			let advanced = false;
			for (const index of candidates) {
				const next = segments[index];
				const d1 = normalizePt(subPt(current.b, current.a));
				const d2 = normalizePt(subPt(next.b, next.a));
				if (Math.abs(crossPt(d1, d2)) < tolerance && d1[0] * d2[0] + d1[1] * d2[1] > 0) {
					current = { a: current.a, b: next.b };
					used[index] = true;
					advanced = true;
					break;
				}
			}
			if (!advanced) break;
		}
		merged.push(current);
	}
	return merged;
}

/**
 * 去掉几何上重复的子段。
 *
 * 两个形状共享一段边界时（相邻矩形、相切圆、重合边），切分后同一段几何边会
 * 被两个操作数各贡献一次，缝合时该顶点处出现两条完全相同的出边，让最右转的
 * 选择变成抛硬币。
 *
 * 判据是「中点 + 方向」而不是只按中点：并集里两条**同向**的重合边表示同一块
 * 边界被算了两遍（应当只留一条），而两条**反向**的重合边则是一进一出、必须都
 * 留着，否则环会在那里断开。只按中点去重会把后一种情况误删，症状是差集里
 * 该挖掉的孔洞反而被填实。
 */
function dedupeSegments(segments) {
	const seen = new Map();
	const out = [];
	for (const segment of segments) {
		const midX = Math.round(((segment.a[0] + segment.b[0]) / 2) * 1e7) / 1e7;
		const midY = Math.round(((segment.a[1] + segment.b[1]) / 2) * 1e7) / 1e7;
		const key = `${midX}:${midY}`;
		const direction = normalizePt(subPt(segment.b, segment.a));
		const existing = seen.get(key);
		if (existing !== undefined) {
			// 同向重复 ⇒ 丢弃后出现的这一条
			const sameDirection = Math.abs(crossPt(existing, direction)) < 1e-9 && existing[0] * direction[0] + existing[1] * direction[1] > 0;
			if (sameDirection) continue;
		}
		seen.set(key, direction);
		out.push(segment);
	}
	return out;
}

/**
 * 沿 `normal`（本形状的外侧）取一个探针点，判定它是否落在 `ringsOther` 内部。
 *
 * 子段的中点在自己形状的边界上，但沿外侧挪开 `step` 后必然落在自己形状**之外**
 * （子段已在交点处切开，附近没有自身的其它边），因此只需要另一个形状的读数：
 * 外侧点在对方内部 ⇒ 该子段在对方内部（两者边界重合），否则在对方外部。
 */
function probeOutside(ringsOther, part, normal) {
	const mid = [(part.a[0] + part.b[0]) / 2, (part.a[1] + part.b[1]) / 2];
	const step = Math.max(PROBE, partLength(part) * 1e-3);
	const outsidePoint = [mid[0] + normal[0] * step, mid[1] + normal[1] * step];
	return ringsContainPoint(ringsOther, outsidePoint);
}

function partLength(part) {
	return distPt(part.a, part.b);
}

function boundaryDistance(rings, p) {
	let best = Infinity;
	for (const ring of rings) {
		for (let i = 0; i < ring.length; i += 1) {
			const hit = closestOnSegment(p, ring[i], ring[(i + 1) % ring.length]);
			if (hit.distance < best) best = hit.distance;
		}
	}
	return best;
}

function isNearBoundary(rings, p, tolerance) {
	return boundaryDistance(rings, p) <= tolerance;
}

/** 多个形状一次并集（逐个归并，结果环数稳定增长，比一次性 N 元更快） */
export function unionAll(shapes) {
	let acc = [];
	for (const shape of shapes) {
		const normalized = normalizeRings(shape);
		if (normalized.length === 0) continue;
		acc = acc.length === 0 ? normalized : booleanRings(acc, normalized, 'union');
	}
	return acc;
}

/**
 * 按环的嵌套深度规范化方向：最外层逆时针（正面积），其内部孔洞顺时针。
 * 结果的面积符号因此可以直接用来看「这是实心还是孔」。
 */
export function orientRings(rings) {
	const normalized = normalizeRings(rings);
	const depths = ringDepths(normalized);
	return normalized.map((ring, index) => {
		const wantCounterClockwise = depths[index] % 2 === 0;
		const isCounterClockwise = signedArea(ring) > 0;
		return isCounterClockwise === wantCounterClockwise ? ring : ring.slice().reverse();
	});
}

/**
 * 每个环的嵌套深度：位于多少个别的环内部（奇偶取模即可判断实心/孔洞）。
 *
 * 这里必须用「多个采样点里被包含次数**最少**的那个」，不能只取质心。
 * 反例：外环 10×10 中间挖 4×4 的孔，孔环的质心 (5,5) 同时落在外环内部，
 * 于是外环和孔环都会算出深度 1——外环被误判成孔洞，整个结果的面积符号
 * 随之翻转（曾经的表现就是「差集面积为 −116」）。
 * 取最小值可以绕开这一整类「共享质心」的假象。
 */
function ringDepths(rings) {
	return rings.map((ring, index) => {
		const probes = sampleInteriorPoints(ring);
		if (probes.length === 0) return 0;
		let best = Infinity;
		for (const probe of probes) {
			let depth = 0;
			for (let otherIndex = 0; otherIndex < rings.length; otherIndex += 1) {
				if (otherIndex === index) continue;
				if (pointInPolygon(probe, rings[otherIndex])) depth += 1;
			}
			if (depth < best) best = depth;
			if (best === 0) break;
		}
		return best;
	});
}

/** 环内的若干采样点，按「越可能代表环自身」排序 */
function sampleInteriorPoints(ring) {
	const out = [];
	if (ring.length < 3) return out;

	let sumX = 0;
	let sumY = 0;
	for (const p of ring) {
		sumX += p[0];
		sumY += p[1];
	}
	const centroid = [sumX / ring.length, sumY / ring.length];
	if (pointInPolygon(centroid, ring)) out.push(centroid);

	const isCounterClockwise = signedArea(ring) > 0;
	const toward = isCounterClockwise ? 1 : -1;
	for (let i = 0; i < ring.length; i += 1) {
		const a = ring[i];
		const b = ring[(i + 1) % ring.length];
		const dx = b[0] - a[0];
		const dy = b[1] - a[1];
		const length = Math.hypot(dx, dy);
		if (length < 1e-12) continue;
		const left = [-dy / length, dx / length];
		for (const scale of [0.02, 0.001, 0.2]) {
			const step = length * scale;
			const candidate = [
				(a[0] + b[0]) / 2 + left[0] * toward * step,
				(a[1] + b[1]) / 2 + left[1] * toward * step,
			];
			if (pointInPolygon(candidate, ring)) {
				out.push(candidate);
				break;
			}
		}
		if (out.length > 12) break;
	}
	return out;
}

/** 找一个确实落在环内部的点 */
export function interiorPoint(ring) {
	const probes = sampleInteriorPoints(ring);
	return probes.length > 0 ? probes[0] : null;
}

// ---------------------------------------------------------------- 轮廓偏移

/**
 * 轮廓偏移（外扩为正、内缩为负）。
 *
 * 用**顶点偏移法**：每条边沿外法线平移 `distance`，相邻两条平移后的直线求交，
 * 交点就是新顶点。外扩时角部得到尖角（miter），内缩时凹角会自然张开。
 *
 * 为什么不用「每条边生成一个四边形再求并集」这条看起来更简单的路：那些四边形
 * 在拼接处会**相互重叠**，而本内核的环用奇偶规则解读——重叠区域会被解读成
 * 孔洞，于是 10×10 外扩 1 会得到「12×12 的外框 + 中间一个 10×10 的洞」。
 * 顶点法生成的是互不重叠的单一环，不存在这个问题。
 *
 * 极端尖角（miter 长度爆炸）会被截断到 `miterLimit × |distance|`；内缩过大时
 * 顶点会越过对边形成自交环，交由布尔运算的自身求并清理掉。
 */
export function offsetRings(rings, distance) {
	const normalized = normalizeRings(rings);
	if (Math.abs(distance) < 1e-12 || normalized.length === 0) return normalized;

	const miterLimit = 12 * Math.abs(distance);
	const out = [];
	for (const ring of normalized) {
		const count = ring.length;
		if (count < 3) continue;
		// 逆时针环内部在左；而 leftNormal() 返回的是**右**法线（见 math.js 注释），
		// 所以逆时针环的外法线方向系数是 +1，顺时针（孔洞）是 -1。
		const outwardSign = signedArea(ring) > 0 ? 1 : -1;
		const shifted = ring.map((current, i) => {
			const previous = ring[(i - 1 + count) % count];
			const next = ring[(i + 1) % count];
			const inDirection = normalizePt(subPt(current, previous));
			const outDirection = normalizePt(subPt(next, current));
			const inLeft = leftNormal(inDirection);
			const outLeft = leftNormal(outDirection);
			const inNormal = [inLeft[0] * outwardSign, inLeft[1] * outwardSign];
			const outNormal = [outLeft[0] * outwardSign, outLeft[1] * outwardSign];

			// 两条平移后的直线求交。参数基准取在 current 上（而不是偏移后的 p0 上），
			// 这样 t 的符号直接表示「沿入边方向走多远」，不会因为偏移方向的正负而翻号。
			const p0 = [current[0] + inNormal[0] * distance, current[1] + inNormal[1] * distance];
			const p1 = [current[0] + outNormal[0] * distance, current[1] + outNormal[1] * distance];
			const denominator = crossPt(inDirection, outDirection);
			if (Math.abs(denominator) < 1e-12) return p0;
			const t = crossPt(subPt(p1, p0), outDirection) / denominator;
			let apex = [p0[0] + inDirection[0] * t, p0[1] + inDirection[1] * t];
			void p1;
			if (distPt(apex, current) > miterLimit) {
				const direction = normalizePt(subPt(apex, current));
				if (direction[0] !== 0 || direction[1] !== 0) {
					apex = [current[0] + direction[0] * miterLimit, current[1] + direction[1] * miterLimit];
				}
			}
			return apex;
		});

		const candidate = cleanRing(shifted);
		if (candidate.length < 3) continue;
		// 内缩过量会让形状整体塌缩：顶点越过对边之后，新轮廓的边长会远小于原边。
		// 判据取「每条新边长都不小于其原边的一半」——过度内缩时新边长会掉到
		// 原边的 20% 以下（10×10 内缩 6 会得到边长 2 的方框，原边是 10），
		// 而正常内缩（圆内缩 2、方内缩 1）的边长比都在 0.6 以上，不会误伤。
		// 这里不用「内切半径」来判：顶点到非相邻边的距离并不是内切半径
		// （正方形会算出 10 而不是 5），据此设阈值会漏判。
		if (distance < 0 && collapsed(candidate, ring)) continue;
		out.push(candidate);
	}
	if (out.length === 0) return [];
	return resolveSelfIntersections(out);
}

/**
 * 内缩过量判定：偏移后有任何一条边的长度塌缩到原边的一半以下。
 * 两条环的边长按索引一一对应（顶点法偏移不改变顶点数）。
 */
function collapsed(candidate, original) {
	if (candidate.length !== original.length) return false;
	for (let i = 0; i < candidate.length; i += 1) {
		const next = (i + 1) % candidate.length;
		const before = distPt(original[i], original[next]);
		const after = distPt(candidate[i], candidate[next]);
		if (before > 1e-12 && after < before * 0.5) return true;
	}
	return false;
}

/**
 * 清理偏移产生的自交：对每个环与自身的其余部分求并集。
 *
 * 偏移量的绝对值较大时（尤其是内缩超过凹角），新顶点会越过对边，环自我交叉；
 * 把环拆成「以每个顶点为基准的三角形扇」再整体求并，自交部分会被并集自然
 * 化简成正确的轮廓。顶点数多时这个做法会明显变慢，因此只在检测到自交时才走
 * 这条路（绝大多数的偏移都不自交）。
 */
function resolveSelfIntersections(rings) {
	const needsRepair = rings.some((ring) => ringHasSelfIntersection(ring));
	if (!needsRepair) return orientRings(rings);

	const pieces = [];
	for (const ring of rings) {
		if (!ringHasSelfIntersection(ring)) {
			pieces.push(ring);
			continue;
		}
		const anchor = ring[0];
		for (let i = 1; i + 1 < ring.length; i += 1) {
			const triangle = cleanRing([anchor, ring[i], ring[i + 1]]);
			if (triangle.length >= 3 && Math.abs(signedArea(triangle)) > 1e-12) pieces.push(triangle);
		}
	}
	if (pieces.length === 0) return orientRings(rings);
	return orientRings(unionAll(pieces));
}

function ringHasSelfIntersection(ring) {
	for (let i = 0; i < ring.length; i += 1) {
		for (let j = i + 1; j < ring.length; j += 1) {
			if (j === i) continue;
			if ((i + 1) % ring.length === j || (j + 1) % ring.length === i) continue;
			const hit = segmentIntersection(ring[i], ring[(i + 1) % ring.length], ring[j], ring[(j + 1) % ring.length]);
			if (hit !== null) return true;
		}
	}
	return false;
}

// ---------------------------------------------------------------- 自检辅助

/**
 * 整组环的净面积。按奇偶规则解读：嵌套深度为奇数的环是孔洞，取负号。
 * 直接对所有环取有向面积之和是错的——环的方向来自缝合，未必已规范化。
 */
export function ringsArea(rings) {
	const normalized = normalizeRings(rings);
	const depths = ringDepths(normalized);
	let total = 0;
	normalized.forEach((ring, index) => {
		const area = Math.abs(signedArea(ring));
		total += depths[index] % 2 === 0 ? area : -area;
	});
	return total;
}

export function ringsSelfIntersections(rings) {
	let count = 0;
	for (const ring of rings) {
		for (let i = 0; i < ring.length; i += 1) {
			for (let j = i + 1; j < ring.length; j += 1) {
				if (j === i || (j + 1) % ring.length === i || (i + 1) % ring.length === j) continue;
				const hit = segmentIntersection(ring[i], ring[(i + 1) % ring.length], ring[j], ring[(j + 1) % ring.length]);
				if (hit !== null) count += 1;
			}
		}
	}
	return count;
}

export function ringPerimeter(ring) {
	let total = 0;
	for (let i = 0; i < ring.length; i += 1) total += distPt(ring[i], ring[(i + 1) % ring.length]);
	return total;
}

export function nearestRingPoint(ring, p) {
	let best = null;
	for (let i = 0; i < ring.length; i += 1) {
		const hit = closestOnSegment(p, ring[i], ring[(i + 1) % ring.length]);
		if (best === null || hit.distance < best.distance) best = hit;
	}
	return best;
}

export function ringsBounds(rings) {
	return rings.reduce((acc, ring) => {
		const b = polygonBounds(ring);
		if (acc === undefined) return b;
		return {
			minX: Math.min(acc.minX, b.minX),
			minY: Math.min(acc.minY, b.minY),
			maxX: Math.max(acc.maxX, b.maxX),
			maxY: Math.max(acc.maxY, b.maxY),
		};
	}, undefined);
}
