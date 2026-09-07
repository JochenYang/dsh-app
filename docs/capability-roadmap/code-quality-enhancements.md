# 代码质量增强（验收钩子 / 审查桥 / 检查点映射）

> 三条互相独立、可分别立项的质量线。共同理念：**质量靠确定性机制回收，
> 不靠模型自觉。** 2026-09-07 修订：补论文依据，砍掉"模型自查"层。

## 0. 理论依据：为什么只做外部反馈（2026-09-07 论文调研）

- Self-Refine（Madaan et al., NeurIPS 2023）：同一模型做 generator + feedback +
  refiner，7 任务平均 +20%。听起来是"自己验自己"可行的证据。
- Huang et al. "Large Language Models Cannot Self-Correct Reasoning Yet"
  （Google DeepMind, ICLR 2024）：去掉 oracle 标签后，**内禀自纠正让所有模型
  在所有推理基准上掉分**（GPT-3.5 在 GSM8K 上 75.9% → 74.7%，Llama-2 从 62%
  崩到 36.5%）。模型把对的改成错的（8.8%）比把错的改成对的（7.6%）还多。
  之前论文的"提升"来自：oracle 反馈、故意写弱的初始 prompt、多采样红利。
- TACL 2024 survey（Kamoi et al.）定论：瓶颈在 feedback 生成——"no prior work
  shows successful self-correction with feedback from prompted LLMs in general
  tasks"；**有可靠外部反馈时自纠正才 work**。
- OpenAI scaling-code-verification（2025-12）：部署时信噪比优先——"A system
  that is slow, noisy, or cumbersome will be bypassed"。

结论：**"发 follow-up 让模型对照需求自查"（intrinsic）不做**——论文证伪，
会把对的改错。**只做"编译器报错喂回给模型修"（外部反馈）**——typecheck
错误是确定性的、不依赖模型判断，模型只需要按报错修（refine 能力论文不否认）。

## 1. 验收钩子（质量反馈环）【停止投入，2026-09-07 结论】

**验证结论**：plugin-verify MVP 已实现并验证（turn/end quiet 回灌 + 基线对比 +
防循环，单测 11/11），但**单 tsc 一道门覆盖面太窄**（仅 TS；JS 零成本可加，
Python/Go/C++/C# 每道都是环境探测坑），对多语言工作区投入产出比不足，停止投入，
代码已移除（未提交过）。

**等效替代（更对路）**：P1 的 DSH 原生 Hook 已支持 post-tool-use /
session-start，用户可为自己的项目配 turn 级验收规则（如 Python 项目配
"写完 .py 跑 ruff"），把语言选择权还给用户，产品不硬编码语言。待 dsh 内核
补 turn 级 hook 事件后，原生格式加一个 `on` 类型即完整。

**问题**：agent 声称完成 ≠ 项目可编译/测试通过。绿测≠需求满足（用户 AGENTS.md 纪律），
但目前这个检查完全依赖用户手动。

**方案**：turn 结束去抖后，套件插件对**该会话工作区**运行验收命令，把
**编译器原文**（外部反馈）回灌为 follow-up 消息给**同一个模型**修：
- 默认验收序列（可按项目配置于 `dsh-app-plugin-verify/config.json`）：
  1. `typecheck`（默认探测 `npm run typecheck`，可覆盖命令）；
  2. 可选：`test` 命令（默认关闭，防大测试套件误触发）。
- 命令执行经 host 侧 `execFile` 参数数组 + 工作区路径围栏（同 plugin-sidebar git-routes
  的安全基线）；超时上限；输出截断（模型可读尾部）。
- 回灌纪律：**只报新增错误**（基线对比：项目本来就红的不报，避免噪声轰炸）；
  成功则**静默**；连续 N 次失败后停止回灌改提示用户（防死循环烧 token）。
- 与 Hooks 的关系：Hooks 是用户自带的守门（P1，拦截型）；本项是产品内建的默认
  验收网（事后检查型），零配置开箱即得。可长期共存。

**MVP**：typecheck-only、单工作区、基线对比、失败回灌 + 防循环。**V2**：项目级自定义
序列、测试命令、报告卡（设置页展示最近验收结果）。
**验收**：故意改坏类型 → 会话自动收到 typecheck 失败摘要 → 模型修好后不再打扰；
无 package.json 的工作区静默跳过；本来就红的项目不轰炸。

## 2. 审查桥（改动 → 审查会话）【未做】

（原文保留，见 git 历史。定位：本地改动一键审查，与验收钩子互补——钩子抓编译，
审查抓逻辑。但注意论文结论：审查者的 feedback 也是 intrinsic 判断，误报率高，
定位为"手动触发"而非自动门。）

## 3. 检查点映射（会话轨迹 ↔ Git 快照）【未做】

（原文保留，见 git 历史。Git 面板标注"此提交由会话 X 创建"，真正的 rewind 不做。）

## 优先级

验收钩子 > 审查桥 > 检查点映射。验收钩子独立于 P0-P3 可先行（无内核依赖），
且直接服务"代码质量"这个用户目标。
