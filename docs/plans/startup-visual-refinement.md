# Startup visual refinement

- Status: done
- Plan date: 2026-10-26
- Risk: medium

## Goal
在不改变启动状态、下载控制、主题与失败恢复逻辑的前提下，提升启动页的品牌辨识度、信息层级和不同窗口尺寸下的构图稳定性；以真实 Chromium 渲染验证，而非只改样式后宣称更好看。

## Scope
- Must-have: 调整 `static/startup.html` 的视觉层级、鲸鱼清晰度、启动进度与五步信息布局、响应式构图；保留全部现有 DOM id 和状态接口；验证 light/dark/reduced-motion、常规与最小窗口、暂停/失败状态。
- Nice-to-have: 在首屏性能不退化的前提下，少量使用已有品牌色和光影增强完成感。
- Out of scope: 不替换鲸鱼资产，不引入图片生成、新依赖、组件库或独立前端工程；不改启动流程、百分比映射、文案、locale、CSP、窗口/导航安全策略；不做移动端产品界面；不添加装饰性卡片或无意义动画；不发版。

## Approach
保留单页静态 HTML 和当前启动状态机，采用“品牌与启动状态为主视觉、鲸鱼为品牌背景主角”的轻量 refinement：
1. 建立稳定的中央内容列与垂直节奏。品牌行略增强，启动标题成为第一信息层级，说明文字降低一级；避免鲸鱼、品牌、状态都同样弱。
2. 鲸鱼保留点阵形象和指针互动，适度缩小其在高窗口中的占高，提升 tile 在 1x/2x DPR 下的实心度、边缘对比与整体轮廓，不再用大片 halo 弥补轮廓不足。
3. 进度区收束为统一宽度的信息组：百分比与轨道基线对齐；五个步骤使用等分网格，去掉竖线分隔和当前项 pill 造成的局部拥挤，保留 done/current/pending 的图形与文字状态。
4. 页脚愿望保持安静但不依附进度组；背景维持现有浅色空气感与深色层次，避免新增彩色玻璃卡片。
5. 高度不足时优先压缩鲸鱼与间距，而不是缩小正文或让步骤溢出；宽度不足时五步允许两行网格，不能横向截断。

## Files and steps
- W1: `static/startup.html` 的 tokens/layout/whale 渲染参数与响应式 CSS。不得修改 `window.__dshStartup*`、现有 DOM id、事件监听和状态计算。
- W2: 在现有根测试目录增加启动页布局/状态守卫，沿用 `test/*.test.mjs` 与 `scripts/` 探针惯例；必要时新增专用 Chromium probe，复用静态页面而非模拟另一套 DOM。
- W3: 新增双语 changeset（`shell: patch`，无插件行为变化）；若修改了相关文档，保持 `docs/agents/commands.md` 的探针表同步。
- W4: 真实渲染验证和独立审查；记录截图/几何/状态证据，不把 CSS 源码断言当作视觉通过。

## Work items
| # | 类目 | 内容 | 状态 |
|---|------|------|------|
| W1 | P1 | 品牌、状态、进度和页脚的视觉层级与鲸鱼清晰度 | [x] |
| W2 | P1 | 常规/最小窗口响应式布局与 light/dark/reduced-motion 完整性 | [x] |
| W3 | P0 | 不破坏已有启动状态、暂停、失败恢复与安全边界 | [x] |
| W4 | P1 | Chromium 实测、自动检查、changeset、独立审查 | [x] |

状态流转：`[ ]` 待办 → `[~]` 已改未审 → `[x]` 审查通过；`[?]` 审查不通过。

## Phases
| 阶段 | 包含条目 | Gate | 状态 |
|------|----------|------|------|
| 1 | W1-W4 | 真实渲染矩阵和测试全 PASS，独立审查无阻塞发现 | [x] |

## Affected behaviors
- `static/startup.html:207-638`：中央舞台、品牌、进度、步骤、页脚和失败卡视觉。
- `static/startup.html:965-1168`：canvas 尺寸/DPR、tile 大小、颜色、透明度和指针互动的性能。
- `static/startup.html:1171-1528`：状态映射和 DOM 更新是冻结边界，不应因视觉重构改变。
- `src/main/startup-window.ts`：保留注入接口；仅当窗口背景 token 与页面确实不一致时才考虑对应修正，并必须解释证据。

## Test plan
| # | 用例 | 输入/操作 | 预期 | 验证方式 | 结果 |
|---|------|-----------|------|----------|------|
| 1 (W1) | 默认构图 | 1440×900 light/dark，启动阶段 4 | 标题与进度为第一信息层级；鲸鱼轮廓清晰；品牌/说明/页脚不抢焦点 | 真实页面截图 + 几何与像素测量 | PASS（截图位于 scratch/startup-shots； whale 平均 alpha 有记录，无新装饰卡片） |
| 2 (W2) | 最小窗口 | 900×600，阶段 4 | 无横向溢出/遮挡/步骤截断；标题与进度完整；原生标题栏不冲突 | 真实页面几何断言 + 截图 | PASS（900×600 内容视口，两行步骤，stage.top >= 38） |
| 3 (W2) | 窄窗口与较长标签 | 900px 宽及 900×600，英文五步标签 | 步骤可读，按两行规则排布，不覆盖进度或页脚 | 注入现有 view 接口 + 几何断言 | PASS（900×600 与 1440×900 英文均实测，scrollWidth <= clientWidth，未截断） |
| 4 (W3) | 状态保持 | 逐阶段推送、未知 progress、100%、暂停/恢复、失败动作 | 与现状相同的状态/百分比/按钮行为；DOM id 可用 | 现有 root tests + 真实接口 probe | PASS（五阶段、阶段4 76%→90%、indeterminate、100%、暂停、失败点击与主按钮焦点通过；root 716 pass/2 skipped/0 fail） |
| 5 (W2) | 动效与可访问性 | light/dark、reduced-motion、正常动效、键盘焦点 | 对比度满足 AA；reduced-motion 无不必要动画；正常模式保留克制动效；焦点可见；错误卡可恢复 | Chromium + 静态检查/现有测试 | PASS（reduce 下装饰动画为 none、正常模式 railSweep/stageFadeIn 生效、真实主按钮焦点与截图；沿用已测对比度 tokens，未改正文色值） |
| 6 (W4) | 首屏性能 | 冷加载与鲸鱼静止/互动 | 不新增依赖/网络；DPR 不降低；不出现明显长任务或持续无意义占用 | probe 帧/长任务观测，维持现有 30fps 上限 | PASS（DPR=1 与 DPR=2 均实测 canvas 匹配；resize 重读 DPR；保留原30fps与循环结构，无新依赖/网络；无独立长任务基准，未宣称量化性能提升） |

## Verification commands
- `npm run typecheck`
- `npm test`
- `node scripts/check-changeset.mjs --base HEAD`
- 真实 Chromium 启动页 probe（实现时确定文件名；须直接加载 `dist/static/startup.html`，同时覆盖 light/dark 与窗口矩阵）
- `git diff --check`

## Deferred
| 项 | 为什么本轮不做 | 何时该回来 |
|---|---|---|
| 重绘鲸鱼或换品牌资产 | 用户目标是现有页面 refinement，不应变成品牌重设计 | 有独立品牌资产设计任务时 |
| 全面 UI 设计系统迁移 | 启动页无 preload、无框架，首屏应继续保持轻量 | 多个壳页面需要共享系统时 |
| 流程文案与启动性能改进 | 不属于视觉优化，避免改变已验证状态机 | 单独提出体验或性能目标时 |
| 启动页布局进入 CI | 本轮以 hand-run probe 覆盖真实渲染，避免为一张静态页引入 Electron CI 步骤；根测试仍守卫脚本解析与文案契约 | 布局回归再次漏过 hand-run，或启动页改动频率上升时 |
| 独立截图评分 | 派出的评审子代理工具集不含 ReadMediaFile，无法看到截图；不接受无输入的打分 | 需要视觉评分时由具备图片读取的评审执行 |

## Rollback
用文件编辑工具恢复本轮变更文件。仅本地静态页面与测试/文档，无用户数据；不得用 Git 历史操作代替回滚。

## Phase log
| 阶段 | 日期 | 证据 | 结论 |
|------|------|------|------|
| 1（实现与实测） | 2026-10-26 | `.devflow/startup-visual-refinement/verification.md`；`npm run typecheck` 0；root `npm test` 718 tests /716 pass/2 skipped/0 fail；`node scripts/check-changeset.mjs --base HEAD` 0；`git diff --check` 0；`node_modules/.bin/electron scripts/probe-startup.cjs` PASS | W1-W4 已改并实测，待独立代码审查。截图/状态/几何/主题/阶段/DPR/暂停/失败恢复通过；独立视觉评分因子代理无图片工具而不可用。四问：状态机未改且真实调用通过；只改静态页/探针/声明文档，未加依赖；两行网格和英文溢出已实测修正；五阶段、失败、reduced-motion 均有反例覆盖。 |
| 2（独立审查后修正） | 2026-10-26 | 审查发现：1440 英文未测、`nth-child(11)/(13)` 死规则导致小窗口偏左、probe console 监听恒空、DPR 只读一次、changeset 与探针表缺失。修正后 `node_modules/.bin/electron scripts/probe-startup.cjs` PASS（含 1440×900 英文一行、900×600 中英文两行、DPR=2、正常/减少动效、五阶段、100%、暂停、失败恢复）；`npm run typecheck` 0；root `npm test` 718/716 pass/2 skipped/0 fail；`check-changeset`/`check:suites`/`check:graph`/`git diff --check` 均 0 | 通过并收尾。四问：每条修正都有探针断言或 gate 输出对应；仅改静态页与探针，无新依赖；新增的 DPR 重读与两行网格已实测；反例覆盖 1440 英文溢出、空选择器、完成态无 current、错误监听。残余：独立视觉评分不可用；未做量化性能基准；无 CI 内布局守卫（见 Deferred）。 |
