# Mimir 路书

[English](ROADMAP.md) | 中文

项目宪章：Mimir 是什么、项目怎么运作、如何保持健康、下一步去哪。日常协作细节见
[CONTRIBUTING.zh.md](CONTRIBUTING.zh.md) 和 [RELEASING.md](RELEASING.md)。

## 1. 定位

**Mimir 是长在 DeepSeek Harness 里的 agent 原生科研工作台**，在一个地方管完科研全周期：

> 选题 → 文献 → 实验 → 图表 → 写作 → 组会

- **Agent 原生，不是外挂 UI。** Agent 会检索 arXiv、给论文相关性打分、给图片命名归档、
  编译 LaTeX、起草 related work、通过独立 subagent 审稿——面板是这些工作的透明窗口，
  不是一个独立应用。
- **全周期、按项目隔离的数据。** 文献、图表、实验、服务器、成长记录都活在同一个本地
  wiki 里，严格按项目分区。两篇论文永远不串。
- **本地优先、开放生态。** 一切跑在用户自己机器上；插件通过 npm 和 dsh-plugin 社区分发。

边界——Mimir **把科研工具链收编进来**，而不是让位给别人：

- **文献管理器**：检索、导入、标签、笔记、去重、BibTeX——一等公民，不是附属功能。
  Zotero 同步是给存量文献库搭的桥，不是边界。
- **LaTeX 编辑器**：语法高亮的源码编辑、一键编译、错误点击跳转、会议模板——目标是
  让论文真的在这里写完，agent 始终在环里。
- **文献阅读器**：全屏 PDF 阅读、批注、结合用户自己研究方向的 AI 相关性评分与摘要。

Mimir **不是**什么：不是托管服务——没有账号、没有云、没有遥测；也不是没有 agent 的
编辑器——每个界面都是为了闭环「写 → 编译 → 审」这条环路。

**目标用户**：已经在用 coding agent、想把同样的杠杆用到科研上的研究生和研究者。

## 2. 项目管理

### 分支与 PR

- `main` 稳定分支，只发版；`dev` 集成分支，日常开发落这里。
- 功能在 `feature/*` / `fix/*` / `docs/*` 分支上做，从 `dev` 切出，PR 回 `dev`。
- **只用 merge commit，不用 squash**——贡献者署名必须留在提交图谱里。
- 每个 PR：CI 全绿（install → build → typecheck → test）、新行为配测试、
  UI 改动附截图 QA、`README.md` 与 `README.zh.md` 保持逐节对齐。

### Issue 与分诊

- 先认领再开工：在 issue 下留言，避免撞车。
- 维护者几天内给新 issue 打标签：`bug`、`enhancement`、`docs`、`good first issue`。
- `good first issue` 池从真实、边界清晰的工作里挑（见 §3 技术债）——这是新贡献者的入口。

### 发版

- 补丁版及时发修复；次版本成批发功能。
- `dsh-mimir` 与 `dsh-client-ui-mimir` 版本锁定、一起发，tag 触发 OIDC trusted
  publishing（见 RELEASING.md）。
- 每次发版同步三个面：npm 包、README 更新日志、官网——绝不只更新一个。

### 社区

- GitHub Discussions + 微信群做用户支持；bug 走 issue。
- 已进 dsh-plugin 生态（awesome 列表、dsh.so artifact 页）——功能集变化时保持收录描述准确。
- 贡献者写进 README 致谢；首次贡献者的 PR 会收到欢迎回复。

## 3. 维护

### 跟踪 dsh 上游

Mimir 最大的外部风险是 dsh 漂移（0.1.2-alpha.4 适配那次：`dsh-client-runtime` 被删、
session/interaction 破坏性变更）。策略：

- `devDependencies` 钉死精确版本；`peerDependencies` 用 `>=` 并在 README 兼容性说明里写清下限。
- 每次 dsh 发新 tag 都检查；升级前先 grep 提交日志里的 `!` 破坏性标记。
- 升级后必须：`build + typecheck + test` 全量跑，然后启动 web 工作台把每个视图截图
  看一遍——类型错误和失效的 inject 只会在运行时暴露。
- 旧 session 缓存 schema 可能导致启动崩溃；遇到时把 `~/.dsh/storages/*` 改名备份
  （绝不直接删）。

### 常驻红线（不许破坏）

- **wiki 域永远停在 version 2**——只做增量变更（可选字段、`.default(...)`），没有迁移机制。
- **所有 CSS 颜色**走 `var(--dsw-*, fallback)`，否则暗色模式崩。
- 新增 `@Remote` 方法后**必须重建两个 remote face**。
- **按项目隔离**——任何新数据类型从第一天起就要带项目作用域。

### 已知技术债（good first issue 池）

2026-09 那批债务已随 0.23.0 清空：ui-mimir 的测试树进了受门禁的 `typecheck`
（`packages/ui-mimir/tsconfig.test.json`），`setup-web-search.sh` 改成合并而非重写
digdig 配置，记录页那两条（lookback 截断吞掉 silences、`since > until` 直通成空窗口）
都已修复并各有测试。

真正还开着的：

- `pnpm test` 里的 `lint-gate.spec.ts` 会七次拉起 ESLint（负载高的机器上每次约 30 秒），
  对每例 60 秒上限——整轮跑挂的可能只是调度而非真的违规。要么让一个 ESLint 进程服务
  全部用例，要么让上限按机器算。
- `downloadTextFile` 已在 `view-common.ts`，但四处视图（`DataSection`、
  `CognitiveBriefView`、`DigestView`、`LedgerView`）仍各自内联同一段 Blob/anchor。
- LaTeX 编辑器是透明 `<textarea>` 叠在高亮层上，因此无法折叠源码。折叠需要换编辑面。
- `ledger.ts` 里 append-only 仍只是**约定**：记录与事件在同一文件锁下硬提交是计划中的加固。

### 官网

`mimir.smartlarkai.com` 从 `website/` rsync 部署。版本号、测试数、截图很容易过时——
每次发版顺手刷新。

## 4. 功能路线

### 近期（至 0.23.0 已交付）

原清单上的条目除注明外均已落地：

- **文献管理器核心**——单篇阅读笔记、标签、项目关联、Zotero 双向导入，以及一键 BibTeX：
  既进某个项目的 `references.bib`，也能把整库导出（`exportLibraryBib`，#322）。
  **仍缺**：合集/文件夹；导入去重目前只有 Zotero 侧查重。
- **文献阅读器**——全屏 PDF、AI 相关性评分、卡片上的一段话摘要。**仍缺**：高亮/批注层——
  阅读器还是 `<iframe>`，批注无处安放。
- **LaTeX 编辑器深化**——命令/环境补全、从项目文献库补全 `\cite` key（#154），加上已有的
  编译/错误跳转闭环。**仍缺**：按 section 折叠、公式悬停预览，两者都需要真正的编辑面，
  而不是现在的 textarea 叠层。
- 图表智能化——上传时 agent 命名，支持用户改名。
- 会议模板——会议模板库（CVPR/ICCV/ECCV/NeurIPS/ICML/ICLR/ACL/AAAI…），
  支持自定义上传与按目标会议重排。
- **会议/期刊信息与 DDL 追踪**——CCF 分级目录、倒计时、按项目 watchlist、`venue_search` 工具。
- 组会 PPT——项目原图与文生图 API 生成图混排。
- 文献视图 UX——订阅与项目可折叠、卡片布局统一。

### 中期

- Zotero 双向同步——**已交付**（`pushZoteroCollection`，#151）；剩下的是两侧都改过时的冲突语义。
- 阅读 → 写作管线——**部分交付**：从文献库起草 related work（#153）与 `\cite` 补全（#154）
  都已落地。批注仍没有存储，所以"批注→引用"这一跳没有源头。
- LaTeX——从项目文献库补全参考文献：**已交付**（#154）。光标联动的排版预览：仍缺。
- 实验自动 ingest——从一次运行的 `metrics.jsonl` 抓取指标**已交付**（#152）；
  监控远程训练任务仍缺。
- 内置 skills 可靠性专项（`/research-plan`、`/write` 等）。
- 成长记录加固：一条记录与其事件在同一文件锁下提交（把 append-only
  保证做硬），出处见 `packages/mimir/src/ledger.ts` 的自注。

### 远期 / 愿景

- 毕业论文模式：多章节项目，把若干篇论文组装成一本学位论文。
- 可复现快照：论文 + 图表 + 实验数据 + 环境打成一个可分享归档。
- 社区 skills：贡献者 skills 目录（审核制、可选安装），沿用组会 skills 的先例。
- 更深的成长记录：研究线分析（drift、停滞检测、周报）。

## 5. 如何参与

挑一个 `good first issue`，或者从 §4 里认领一项、先开个 discussion 讨论。
UI 工作永远欢迎——但要带截图交付，不靠感觉。
