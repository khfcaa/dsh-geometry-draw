/** 几何内核自测：布尔运算、偏移、方向规范化。断言失败即报错退出。 */
import {
	booleanRings,
	offsetRings,
	orientRings,
	ringsArea,
	ringsBounds,
	ringsSelfIntersections,
	unionAll,
} from '../src/geometry.js';
import { signedArea } from '../src/math.js';

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

function near(actual, expected, tolerance, name) {
	check(name, Math.abs(actual - expected) <= tolerance, `(actual ${actual}, expected ${expected})`);
}

const rect = (x, y, w, h) => [
	[
		[x, y],
		[x + w, y],
		[x + w, y + h],
		[x, y + h],
	],
];

const square = (cx, cy, half) => rect(cx - half, cy - half, half * 2, half * 2);

// 正 n 边形（外接圆半径 r），逆时针
function regular(cx, cy, r, n, phase = 0) {
	const pts = [];
	for (let i = 0; i < n; i += 1) {
		const a = phase + (2 * Math.PI * i) / n;
		pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
	}
	return [pts];
}

console.log('\n[1] 并集：两个分离的矩形');
{
	const out = booleanRings(rect(0, 0, 2, 2), rect(5, 0, 2, 2), 'union');
	near(out.length, 2, 0, '两个环');
	near(ringsArea(out), 8, 1e-6, '面积为 4 + 4');
	check('无自交', ringsSelfIntersections(out) === 0);
}

console.log('\n[2] 并集：重叠矩形');
{
	const out = booleanRings(rect(0, 0, 4, 4), rect(2, 2, 4, 4), 'union');
	near(out.length, 1, 0, '合成一个环');
	near(ringsArea(out), 28, 1e-6, '面积为 16 + 16 - 4');
	const b = ringsBounds(out);
	check('包围盒正确', b.minX === 0 && b.minY === 0 && b.maxX === 6 && b.maxY === 6, JSON.stringify(b));
}

console.log('\n[3] 交集：重叠矩形');
{
	const out = booleanRings(rect(0, 0, 4, 4), rect(2, 2, 4, 4), 'intersect');
	near(out.length, 1, 0, '一个环');
	near(ringsArea(out), 4, 1e-6, '面积为 2×2');
}

console.log('\n[4] 差集：挖孔（内矩形完全包含）');
{
	const out = booleanRings(rect(0, 0, 10, 10), rect(3, 3, 4, 4), 'difference');
	near(out.length, 2, 0, '外环 + 孔洞');
	near(ringsArea(out), 100 - 16, 1e-6, '面积为 100 - 16');
	check('无自交', ringsSelfIntersections(out) === 0);
}

console.log('\n[5] 差集：不相交（保持原样）');
{
	const out = booleanRings(rect(0, 0, 2, 2), rect(9, 9, 2, 2), 'difference');
	near(ringsArea(out), 4, 1e-6, '面积不变');
}

console.log('\n[6] 异或：重叠矩形');
{
	const out = booleanRings(rect(0, 0, 4, 4), rect(2, 2, 4, 4), 'xor');
	near(ringsArea(out), 24, 1e-6, '面积为 16 + 16 - 2×4');
}

console.log('\n[7] 一般位置：两个旋转正方形（非轴对齐，含 8 个交点）');
{
	const a = regular(0, 0, 3, 4, Math.PI / 4);
	const b = regular(1.3, 0.7, 3, 4, 0.2);
	const union = booleanRings(a, b, 'union');
	const inter = booleanRings(a, b, 'intersect');
	const areaA = ringsArea(a);
	const areaB = ringsArea(b);
	near(ringsArea(union), areaA + areaB - ringsArea(inter), 1e-4, '容斥原理 |A∪B| = |A|+|B|-|A∩B|');
	check('并集自交数为 0', ringsSelfIntersections(union) === 0, `(${ringsSelfIntersections(union)})`);
	check('交集自交数为 0', ringsSelfIntersections(inter) === 0, `(${ringsSelfIntersections(inter)})`);
}

console.log('\n[8] 圆（离散化）的布尔运算');
{
	const circle = (cx, cy, r, n = 256) => {
		const pts = [];
		for (let i = 0; i < n; i += 1) {
			const a = (2 * Math.PI * i) / n;
			pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
		}
		return [pts];
	};
	const c1 = circle(0, 0, 5);
	const c2 = circle(6, 0, 5);
	const inter = booleanRings(c1, c2, 'intersect');
	// 两圆相交面积解析解：2r²cos⁻¹(d/2r) − (d/2)√(4r²−d²)
	const r = 5;
	const d = 6;
	const exact = 2 * r * r * Math.acos(d / (2 * r)) - (d / 2) * Math.sqrt(4 * r * r - d * d);
	near(ringsArea(inter), exact, 0.05, '两圆交叠面积接近解析解');

	const ring = booleanRings(c1, c2, 'difference');
	check('差集无自交', ringsSelfIntersections(ring) === 0, `(${ringsSelfIntersections(ring)})`);
	near(ringsArea(ring), Math.PI * r * r - exact, 0.2, '差集面积');
}

console.log('\n[9] 偏移：正方形外扩/内缩');
{
	const out = offsetRings(rect(0, 0, 10, 10), 1);
	near(ringsArea(out), 144, 0.5, '外扩 1 → 12×12');
	const inner = offsetRings(rect(0, 0, 10, 10), -1);
	near(ringsArea(inner), 64, 0.5, '内缩 1 → 8×8');
	const gone = offsetRings(rect(0, 0, 10, 10), -6);
	near(ringsArea(gone), 0, 0.5, '内缩超过半宽 → 空');
}

console.log('\n[10] 偏移：圆形近似');
{
	const circle = (() => {
		const pts = [];
		for (let i = 0; i < 256; i += 1) {
			const a = (2 * Math.PI * i) / 256;
			pts.push([Math.cos(a) * 5, Math.sin(a) * 5]);
		}
		return [pts];
	})();
	const out = offsetRings(circle, 2);
	near(ringsArea(out), Math.PI * 49, 1.0, '半径 5 外扩 2 → π·7²');
}

console.log('\n[11] 方向规范化');
{
	const outer = rect(0, 0, 10, 10).flat();
	const hole = rect(3, 3, 4, 4).flat().reverse();
	const oriented = orientRings([outer, hole]);
	check('外环逆时针、孔洞顺时针', signedAreaOf(oriented[0]) > 0 && signedAreaOf(oriented[1]) < 0);
}

function signedAreaOf(ring) {
	let sum = 0;
	for (let i = 0; i < ring.length; i += 1) {
		const a = ring[i];
		const b = ring[(i + 1) % ring.length];
		sum += a[0] * b[1] - b[0] * a[1];
	}
	return sum / 2;
}

console.log('\n[12] 多形状归并（unionAll）');
{
	const out = unionAll([rect(0, 0, 2, 2), rect(1, 1, 2, 2), rect(2, 2, 2, 2)]);
	near(out.length, 1, 0, '一条链合成一个环');
	near(ringsArea(out), 4 + 4 + 4 - 1 - 1, 1e-6, '面积为 12 - 2');
}

console.log(`\n通过 ${passed} 项，失败 ${failures.length} 项`);
if (failures.length > 0) {
	console.log('失败清单：');
	for (const f of failures) console.log('  - ' + f);
	process.exit(1);
}
