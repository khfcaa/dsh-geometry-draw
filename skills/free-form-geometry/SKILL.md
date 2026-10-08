---
name: free-form-geometry
description: Use when a drawing must be produced rather than described — filled complex shapes, regions with holes, boolean combinations (union/intersect/difference/xor), outlined or offset contours, symmetric ornaments and rotational arrays, gradient or pattern fills, parametric/polar curves, or annotated geometric constructions. Covers how to compose the `geometry_draw` spec, how to self-check the render before delivering, and the failure modes that are invisible in a thumbnail.
---

# 自由几何绘图

产出**图**（不是描述图）时用这套流程：写一份 `geometry_draw` 规格 → 用 `preview: true` 拿回 PNG →
**自己看图并改** → 满意才交付。规格是声明式的：不写渲染代码、不手写 SVG 字符串。

## 铁律

1. **不要手写 SVG 或绘图脚本。** 需要布尔运算、多轮廓填色、渐变、阵列时，手拼
   路径字符串几乎必然出错，而且没有自检。全部走 `geometry_draw`。
2. **坐标是数学坐标**：x 向右、**y 向上**。屏幕坐标的直觉（y 向下）是这里最容易
   犯的错；`label_offset` 是唯一按屏幕像素给的地方（y 向下）。
3. **先画一版，再看图。** 缩略图上看不出的问题（孔洞被填实、轮廓自交、标注叠在
   线上）只能靠 `preview: true` 拿回 PNG 自己看，或者读 `warnings`。
4. **交付前必须过一遍下面的自检清单。** 尤其在用户只给了口头描述、没有参考图时。

## 工作流

1. **拆解**：把用户的描述变成「一块块区域」——哪些是实心、哪些是孔、哪些只是描边。
   孔洞不要用「画一个白色形状盖住」来伪造，要用 `boolean: "difference"` 真正挖出来。
2. **定坐标**：给一个 `xRange`/`yRange`（例如 `[-10, 10]`），或干脆不给让工具自动适配。
   用 `vars` 保存会重复出现的量（半径、齿数），后面所有数字都能写成表达式。
3. **搭结构**：用 `group` 归拢相关元素；对称与阵列用 `repeat`/`mirror`，不要手抄 12 份坐标。
4. **上色**：纯色直接写 `"#3b82f6"`；渐变写对象；纹理写 `pattern`。多轮廓形状显式写
   `fill_rule: "evenodd"`。
5. **标注**：`point` 带 `label`、`angle`（`right: true` 出直角符号）、`dimension` 出尺寸线。
6. **自检**：`preview: true` 出图 → 看图 → 改。读 `warnings`，它报的是退化轮廓、
   自交、填充规则隐患这类肉眼难辨的问题。
7. **交付**：把返回的 `markdown` 片段用起来，不要再自己拼路径。

## 规格速查

顶层：`width` `height` `padding` `background` `xRange` `yRange` `vars` `shapes` `title` `elements`。

| 想要 | 写法 |
|---|---|
| 矩形/圆/椭圆 | `{type:"rect", center, width, height, rx?}`、`{type:"circle", center, radius}`、`{type:"ellipse", center, rx, ry}` |
| 多边形/折线/星形 | `{type:"polygon", points:[[x,y],…]}`、`{type:"star", center, radius, inner_radius, points}` |
| 任意曲线轮廓 | `{type:"path", d:"M… C… Z"}`（原生 SVG 路径数据） |
| 挖孔/合并/相交/异或 | `{type:"boolean", boolean:"difference", elements:[外形, 要挖掉的形状…]}` |
| 轮廓外扩/内缩 | 任意形状加 `offset: 0.5`（正外扩、负内缩） |
| 旋转阵列 | `repeat: {count: 12, about: [0,0], mirror_each: true}` |
| 镜像 | `mirror: {axis: "x"}` 或 `{angle: 30, through: [0,0]}` |
| 渐变 | `fill: {type:"linear", from:[-5,0], to:[5,5], stops:[{offset:0,color:"#60a5fa"},{offset:1,color:"#1d4ed8"}]}` |
| 图案填充 | `fill: {type:"pattern", tile:14, background:"#fef3c7", shapes:[{type:"diagonal", color:"#f59e0b", stroke_width:3}]}` |
| 函数曲线 | `{type:"curve", y:"sin(x)*2", domain:[-6,6]}` |
| 参数方程 | `{type:"parametric", x:"cos(t)*3", y:"sin(2t)*2", range:[0, "2*pi"]}` |
| 极坐标 | `{type:"polar", r:"3*cos(3*theta)"}` |
| 顶点/文字 | `{type:"point", at:[1,2], label:"A"}`、`{type:"text", at:[0,5], text:"…", size:16}` |
| 角弧/直角 | `{type:"angle", at:[0,0], from:[3,0], to:[0,4], label:"α", right:false}` |
| 尺寸线 | `{type:"dimension", from:[-6,-3], to:[5,-3], offset:-0.9, label:"11"}` |

样式字段（任意元素可用）：`fill` `stroke` `stroke_width` `stroke_dasharray` `fill_opacity`
`stroke_opacity` `opacity` `fill_rule`。变换：`transform: {rotate, scale, translate, about, mirror}`
或 SVG 风格字符串 `"rotate(30) translate(1,2)"`。

表达式可用：`+ - * / % ^`、隐式乘法（`2x`、`3sin(t)`）、`pi/tau/e/phi`、
`sin cos tan asin acos atan atan2 sqrt cbrt abs exp ln log log2 floor ceil round sign min max pow hypot mod`。

## 构图配方

- **带孔的徽章**：`boolean: "difference"` = 外轮廓 −（内轮廓 + 要挖的圆/星）。
- **雪花/花纹**：画**一个**臂（用 `path` 或 `polygon`），再 `repeat: {count: 6, mirror_each: true}`。
- **环带**：同一个形状两次，一个 `offset` 为正、一个为负，用 `difference` 相减。
- **玫瑰花窗**：外圆 − n 个等分圆（`repeat` 版圆），再叠加 `star`。
- **坐标网格上的曲线**：`xRange`/`yRange` 定窗口，`curve`/`parametric` 画线，
  需要填色就给它们加 `fill`（此时按闭合轮廓处理）。
- **作图题**：`polygon` + `point` 标签 + `angle`/`right` + `dimension`，一套齐。

## 已知坑

| 症状 | 原因与解法 |
|---|---|
| 该是孔的地方被填实 | 多轮廓形状没写 `fill_rule: "evenodd"`；或轮廓方向与预期不符——显式写规则即可，本工具按奇偶规则解释多轮廓 |
| 图形整体跑出画布 | 给了 `xRange`/`yRange` 但内容不在其中；读返回的 warning，或去掉范围让工具自动适配 |
| 曲线画出横向长直线 | 函数有极点（如 `tan`）或定义域外取值；本工具会断开，但 `samples` 太低时断点会不准，提高 `samples` |
| 文字压在图形上 | `text`/`point.label` 的 `at` 只是锚点，用 `offset` 推开；`point` 的 `label_offset` 单位是屏幕像素 |
| 内缩把形状缩没了 | 期望行为：内缩超过形状内切半径会返回空，工具会给出 warning |
| 输出文件找不到 | 路径是**工作区相对**的；传目录或完整文件名，越界路径会被拒绝 |

## 自检清单（交付前逐条过）

1. `preview: true` 拿到 PNG，**真的看了一眼**——孔洞存在吗？有没有元素互相压住？
2. `warnings` 为空，或每一条都已判断「可以接受」。
3. 标注文字没有叠在图形边上；顶点标签在顶点外侧。
4. 画布没有大片空白（自动适配应该贴边；有空白就检查是否有多余的远处元素）。
5. 交付的是工具返回的 `markdown`/路径片段，没有再手写。

## 维护

- 规格与实现的权威定义在插件源码 `src/compiler.js`（元素表）与 `src/geometry.js`（布尔与偏移）；
  `index.js` 里的工具描述是模型看到的那一份，改动时两边要同步。
- 自测：`node tests/geometry-test.mjs`（几何内核）、`node tests/tool-test.mjs`（工具层）、
  `node tests/compiler-smoke.mjs`（渲染冒烟）。
