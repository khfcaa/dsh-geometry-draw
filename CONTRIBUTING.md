# 贡献指南

感谢你愿意改进 `dsh-geometry-draw`。这份文档只讲**这个仓库真正在乎的事**：
几何正确性、可复现的测试、以及「不要让模型手写 SVG」这条设计边界。

## 先看这三份文件

| 文件 | 为什么先看 |
|---|---|
| [`README.md`](README.md) | 能力范围、安装方式、规格速览 |
| [`skills/free-form-geometry/SKILL.md`](skills/free-form-geometry/SKILL.md) | 构图流程、配方、已知坑、交付前自检清单 |
| [`src/geometry.js`](src/geometry.js) | 布尔运算与轮廓偏移的判据都写在函数上方的注释里 |

## 开发环境

只需要 Node.js **≥ 22**（仓库使用 `node --test` 之外的自带测试脚本，没有别的构建步骤）。

```bash
git clone https://github.com/khfcaa/dsh-geometry-draw.git
cd dsh-geometry-draw

# 可选：装 resvg 用于 PNG 栅格化与渲染冒烟测试。
# 不装也能开发几何内核（geometry-test 不依赖它），只是 PNG 相关测试会跳过。
npm install @resvg/resvg-js
```

## 跑测试

```bash
node tests/geometry-test.mjs     # 几何内核：布尔四运算、圆交叠解析解、偏移、方向规范化
node tests/tool-test.mjs         # 工具层：文件落盘、结果结构、参数校验、沙箱边界、表达式
node tests/compiler-smoke.mjs    # 渲染冒烟：布尔/孔洞/阵列/标注四张图真的渲染出来
node tests/demo-gallery.mjs      # 能力演示：画 6 张示例图到 tests/demo/
```

`npm test` 一次跑完前三个。**提交前请确保三者都是绿的**——CI 会跑同样的命令。

改动几何内核时，请遵守一条硬规则：**断言用解析解或守恒律，不要用「看起来对」**。
现有测试就是这么写的，可以照抄思路：

- 布尔运算用**容斥原理** `|A∪B| = |A|+|B|-|A∩B|` 交叉验证，而不是只对面积写死一个数；
- 两圆交叠用解析解 `2r²cos⁻¹(d/2r) − (d/2)√(4r²−d²)` 比对；
- 偏移用「外扩 1 得到 12×12」「内缩超过半宽必须消失」这类**可解释**的期望值。

## 提交 PR

1. **一个 PR 只做一件事。** 几何内核的修复和文档润色请分开。
2. **说清判据。** PR 描述里写：原来错在哪（给出可复现的规格或失败断言）、改成了什么、为什么这是对的。
3. **带上测试。** 修 bug 就补一个能复现它的断言；加元素类型就在 `tests/tool-test.mjs` 或 `compiler-smoke.mjs` 里加一例。
4. **别扩大依赖。** 本插件刻意**零运行时依赖**：几何、表达式求值、SVG 生成全部自己写；PNG 栅格化复用宿主已有的 `@resvg/resvg-js`。新增运行时依赖需要非常强的理由。
5. **保持输出 schema 在受限子集内。** DSH 的工具 schema 只接受单类型（`type: 'string'`），**不能写 `type: ['string','null']`** —— 这会让整个插件激活失败。可选字段用空字符串/`0` 表示「无」。
6. **改 tool 描述时同步 SKILL.md。** 模型看到的是 `index.js` 里的 `SPEC_HELP`/`COOKBOOK`，人看到的是 `SKILL.md`，两边说的是同一套规格。

## 代码风格

- 缩进用 **Tab**，字符串用单引号，语句带分号（见 `.editorconfig`）。
- 注释写**为什么**，不写「这行在赋值」。尤其是那些踩过坑的地方——`src/geometry.js` 里
  「子段中点贴在自己边界上」「外侧探针的符号方向」「缝合依赖端点 key 一致性」三条，
  请保留它们的解释，它们是这个内核最贵的知识。
- 面向使用者的文案（README、报错信息、warning）用中文；标识符与 API 名用英文。

## 提交信息

用祈使句、一句话说清这次改动做了什么：

```
修复差集在共享边上的缝合断裂

两个矩形共享一条边时，端点坐标相差 1e-16 导致 key 不一致、缝合失败。
在 splitAtIntersections 之后统一按 1e-9 网格吸附端点。
```

## 行为准则

参与本项目即视为同意 [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md)。
