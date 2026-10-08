<!-- 感谢提交 PR。请把下面填完 —— 空白模板会被直接关掉。 -->

## 这次改动做了什么

<!-- 一句话说清。一个 PR 只做一件事。 -->

## 为什么

<!-- 原来错在哪 / 缺什么。修 bug 请给可复现的规格或失败断言。 -->

## 判据

<!-- 最关键的一节：你凭什么认为改完是对的？ -->

- [ ] 我的断言用的是**解析解或守恒律**（例如容斥原理 `|A∪B| = |A|+|B|-|A∩B|`、两圆交叠解析解），不是「看起来对」的数值
- [ ] 新行为有对应的测试覆盖（说明在哪个文件、哪一条）
- [ ] 我没有新增运行时依赖（或已在下方说明为什么必须）

## 检查清单

- [ ] `node tests/geometry-test.mjs` 全绿
- [ ] `node tests/tool-test.mjs` 全绿
- [ ] `node tests/compiler-smoke.mjs` 全绿
- [ ] `npm run check` 通过
- [ ] 如果改了工具描述（`index.js` 的 `SPEC_HELP`/`COOKBOOK`），`skills/free-form-geometry/SKILL.md` 已同步
- [ ] 如果改了工具输出 schema，我确认**没有**使用 `type: [...]` 类型数组（会让插件激活失败）
- [ ] 如果改了公开行为，`CHANGELOG.md` 的 `[Unreleased]` 已更新
- [ ] 面向使用者的文案是中文，标识符是英文

## 渲染证据

<!-- 画图类的改动请贴一张改前/改后的 PNG；CI 也会把 tests/out/ 作为 artifact 上传。 -->

## 关联 Issue

<!-- Closes #123 -->
