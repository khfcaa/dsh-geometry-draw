# 示例

6 份**可以直接用**的 `geometry_draw` 规格，以及它们的渲染产物。全部由
[`tools/make-examples.mjs`](../tools/make-examples.mjs) 用插件自己的编译器生成，
每次都跑一遍插件真正使用的自检（`auditFigure`），**要求 0 warning**。

重新生成：

```bash
python -c "print()" >/dev/null  # 只是为了确认 Python 可用（头图才需要它）
npm install @resvg/resvg-js     # 栅格化依赖，可选但推荐
npm run gallery
```

| 示例 | 关键词 | 规格 | 渲染 |
|---|---|---|---|
| 布尔差集 + 线性渐变 | `boolean: difference`、`linear` 渐变、`fill_rule` | [json](01-boolean-gradient.json) | [png](assets/01-boolean-gradient.png) · [svg](assets/01-boolean-gradient.svg) |
| 轮廓偏移环带 + 图案填充 | `offset: ±d`、`pattern` 填充 | [json](02-offset-ring-pattern.json) | [png](assets/02-offset-ring-pattern.png) · [svg](assets/02-offset-ring-pattern.svg) |
| 旋转阵列 + 镜像 | `repeat`、`mirror_each` | [json](03-repeat-mirror.json) | [png](assets/03-repeat-mirror.png) · [svg](assets/03-repeat-mirror.svg) |
| 极坐标玫瑰线 | `polar`、`radial` 渐变 | [json](04-polar-rose.json) | [png](assets/04-polar-rose.png) · [svg](assets/04-polar-rose.svg) |
| 参数方程曲线 | `parametric`、自交且填色 | [json](05-parametric-lissajous.json) | [png](assets/05-parametric-lissajous.png) · [svg](assets/05-parametric-lissajous.svg) |
| 几何标注 | `point`、`angle.right`、`dimension` | [json](06-annotation.json) | [png](assets/06-annotation.png) · [svg](assets/06-annotation.svg) |

`assets/manifest.json` 记录每张图的画布尺寸与几何统计（轮廓数、点数、自交数、warning）。

## 怎么用

每个 JSON 的结构是 `{ name, title, figure }`：把 **`figure` 原样传给 `geometry_draw`**
即可（`name` 用来当输出文件名）。如果用的是 MCP/CLI 之外的方式，直接照着抄 `figure` 里的内容。

## 三个值得记住的构图结论

这些是画这 6 张图时真正踩到的东西，写下来省得后人再踩一遍：

1. **星形要完全落在圆内，才是一个「星形孔洞」。** 若星尖伸到圆外，`difference`
   会把圆周切成几个碎片。判据：外接半径 × cos(π/5) 要大于内接半径。
2. **玫瑰线的花瓣数：n 为奇数时是 n 瓣，偶数时才是 2n 瓣。**
   所以 `r = a·cos(3θ)` 就是 3 瓣；奇数 n 的周期是 π，扫满 2π 只是把同一朵花描两遍。
3. **偏移环带用圆，不要用多角星。** 星形的凹角在偏移后很容易自交，
   得到交错的怪形状；圆做外扩/内缩相减永远是干净的环。

另外两条与工具无关、但会直接影响出图效果的：

- **尺寸线的 `offset` 正负是「往图形外 / 往图形里」。** 用错符号，尺寸线会直接穿进图形。
- **`opacity`（组透明度）在 resvg 下遇到退化包围盒会 panic**，`fill_opacity` 不会。
  作图脚本优先用 `fill_opacity`。
