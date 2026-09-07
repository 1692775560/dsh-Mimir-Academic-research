# Mimir 路线图

目标模式的工作队列。每项在一个迭代内交付：在开发仓库（`~/deepseek-harness`）实现，测试 + 截图 QA，同步回这里，推送。
优先级：文献+实验 > 写作 > 服务器，每隔几个迭代做一轮纯 UI/UX 打磨。

## 进行中

- [x] Agent 工件入库（Issue #30）：`figure_save` 将生成的图片复制到所选项目的 `figures/` 目录，在 wiki 中记录图注/来源/实验元数据，并返回一段 LaTeX 片段；图表视图展示这些元数据。
- [x] 标准 Playwright E2E 套件（Issue #13）：核心六视图与文献检索场景，可对挂载的 dsh Web URL 复用，配置了 `DSH_E2E_URL` 时在 CI 上传构件。
- [x] npm 发布准备（Issue #2）：Node engines、pack 校验、tag 触发的 provenance 工作流与发布文档。首次发布仍卡在 npm publisher 认证上。

## 已完成

- [x] 内置科研技能（v0.8.0）：九个 ARIS 风格工作流手册
      （pipeline / lit-review / novelty-check / experiment-plan /
      result-to-claim / paper-drafting / citation-audit / rebuttal /
      figure-plan）随 dsh-mimir 打包，并在运行时以 rank 250 经
      `ctx.skills.register()` 注册——项目级同名技能优先；`skills`
      服务经 `ctx.inject` 消费，因此无注册表的组合加载不受影响；
      `skills.enabled` 配置开关；正文以模板字面量随包携带（仅 lib 发布）

- [x] 服务器标签 + 实验服务器关联：ServerRecord 新增 `tags`
      （`.default([])`，无版本升级），saveServer 做清洗
      （trim/去空/去重）；ExperimentRecord 新增 `serverId`（可选，无
      升级）及新的 `updateExperiment` Remote（关联 / 置空 / 未知服务器
      返回 `invalid-input`）；服务器视图的表单和卡片上有标签 chips，
      另有标签过滤栏；实验表格每行显示已关联服务器徽标及内联换绑下拉框；
      总览新增服务器统计 chip
- [x] 实验对比：由指标对比条形图承载（每个被 ≥2 次运行共享的数值指标
      一张内联 SVG 图），而非基于选择的表格
- [x] 实验创建/编辑内联表单：新的 `saveExperiment` Remote
      （32 个 research 方法）——全字段 upsert（创建时生成新的 `exp-` id，
      两条路径都刷新 `updatedAt`），带项目存在
      （`project-not-found`）、名称非空、状态合法、metrics 形状、
      关联服务器存在（`invalid-input`）校验。实验视图工具栏打开表单卡片
      （名称 / 状态下拉 / 动态 metrics 键值行——看似数字的值按数字存储，
      空键丢弃—— / 可选服务器选择），行内 Edit 回填，保存后 patch 已加载
      分片并弹 toast
- [x] 大纲拖拽排序（sections）：每个顶层大纲行增加拖拽把手
      （HTML5 DnD，指针下方显示插入指示条）；放置时重写 `main.tex` 的
      顶层 `\section` 顺序（块连同其子节整体移动，其余内容逐字节不变——
      纯 `reorderSections` 行置换 + 新的 `reorderPaperSections` Remote，
      带乐观 `baseOutline` 检查，冲突则重新加载）；编辑器有未保存改动时
      禁止拖拽
- [x] 大纲拖拽排序（subsections）（Issue #10）：子节行获得同样的拖拽把手；
      放置时在所属节内重排，或跨节移动块（手势进行中，无子节的节下方出现
      虚线放置区）——纯 `reorderSubsections` 行置换（`\subsubsection`
      随行，未移动的块逐字节不变）+ 新的 `reorderPaperSubsections` Remote，
      其 `baseOutline` 冲突检查覆盖整个节/子节树
- [x] 论文视图布局：大纲/编辑器/预览之间的拖拽把手调整窗格大小
      （纯 `railWidthFromDrag`/`editorShareFromDrag` 钳制运算，
      rail 在 60px 以下吸附为折叠，编辑器 ≥320px / 预览 ≥280px），
      宽度持久化到 localStorage（`mimir.paperLayout`）；编辑器和预览
      各自从头部按钮进入全屏，Esc 先退全屏再关面板
      （`shortcutFor` 接收全屏标志）
- [x] BibTeX 管理：论文视图的文献面板读取项目的 `references.bib`
      （容错的零依赖解析器，带 parse∘serialize round-trip 不变量），
      列出条目并支持删除，把文献库论文追加为 `@misc` 条目——从面板的
      导入选择器或每张文献卡片的一键按钮（新的 `getBibliography` /
      `saveBibliography` / `importPapersToBib` Remote；删除与导入在乐观
      并发下写文件，冲突则重新加载）
- [x] 图表视图：上传 / 删除 / 复制 LaTeX 片段的图片管理
- [x] 服务器视图：CRUD + TCP 探测 + SSH nvidia-smi GPU 条形图
- [x] SSH 远程任务（Issue #6）：服务器视图的任务区块向记住的服务器提交
      命令（新的 `submitJob` / `listJobs` / `deleteJob` Remote，基于新的
      `jobs` wiki 表——无版本升级加入，排除在六表导出快照之外）。宿主侧
      通过 batch-mode ssh 在后台运行命令（30 分钟会话上限，记录上保留
      8 KB stdout/stderr 尾部）；有任何任务排队/运行时面板每 2 秒轮询，
      终态翻转时弹 toast。任务关联到所选项目的实验时，提交即把该实验
      翻转为 running（+ 服务器关联），settle 时翻转为 success/failed
- [x] UI 刷新：导航图标、视图标题、统计 chips、状态 pills
- [x] 面板内 arXiv 检索：文献视图中的搜索框，一键导入 wiki 文献库
      （外加文献卡片删除）
- [x] 编译问题点击跳转：点击论文视图中的 LaTeX 错误/警告，编辑器跳到
      对应行（行号徽标、槽位闪烁、编辑器不换行以保证行号不漂移）
- [x] 实验指标图表：被 ≥2 次运行共享的数值指标键渲染为内联 SVG 对比
      条形图；实验行可删除（新的 `deleteExperiment` Remote；
      "添加实验"表单被跳过——当时还没有 saveExperiment Remote）
- [x] 文献打标 + 论文的按项目关联（新的 `updatePaper` Remote；
      标签 pills、项目徽标、内联编辑器、标签/当前项目过滤栏；
      PaperRecord 新增 `tags`/`projectIds` 带 zod 默认值，无 wiki 版本升级）
- [x] 编辑器中的 LaTeX 语法高亮：零依赖 overlay
      （透明文字 textarea 叠在按 token 渲染的 `pre` 之上）；单遍
      tokenizer，含 plain/comment/command/math/brace/bracket/env token，
      转义安全（`\%` 保持 plain），同行 `$…$` 配对；超过 200 KB 退化为
      纯文本
- [x] UI 打磨轮：深色模式 + 语言切换 + 键盘快捷键。两个开关都走宿主
      服务（`ctx.theme` / `ctx.locale`，经 Host 设置持久化——不用面板本地
      localStorage）：头部有日/月和中/EN 按钮；面板只在
      `body[data-ds-dark-theme]` 下重着色私有的 `--mimir-tok-*`
      语法色，外加 `error-secondary`（深色基础调色板中的描边 token，
      此处用作填充）。快捷键（纯 `shortcutFor` 映射，输入时屏蔽）：
      `1–6` 切换视图，`Esc` 关闭，`⌘/Ctrl+Enter` 编译；rail 底部有提示行。
      （快捷键打开面板被跳过——宿主侧栏拥有该入口。）
- [x] 窄宽度布局适配：900px 以下论文视图退化为单窗格编辑器/预览标签栏
      （`paperSoloPane` 决定可见窗格；现有全屏 CSS 隐藏另一窗格、大纲
      rail 和拖拽把手）；700px 以下侧栏变为顶栏，带横向滚动导航和通栏
      项目行。卡片栅格本就经 `auto-fill minmax` 退化为单列。另修复一个
      先前存在的 flex bug：过长的 nowrap 项目标题把侧栏撑破其 216px
      基准（`.side` 现有 `min-width: 0`），实验错误态加上了重试按钮。
- [x] 实验日志 Markdown 渲染：工件查看器用零依赖受限解析器渲染
      `EXPERIMENT_LOG.md`（`markdown.ts` 块 + 内联 span，`MarkdownView.tsx`
      渲染器）——标题 #–####、粗体/斜体/行内代码、围栏代码（未闭合围栏
      吞掉余下内容）、无序/有序列表、引用、分隔线、管道表格和链接；
      `safeLinkUrl` 把一切非 http(s) scheme（`javascript:`、`data:`、…）
      中和为纯文本。未识别语法保持字面。样式走共享的 `--dsw-*` token，
      深色模式随之生效。
- [x] 图表拖拽上传：把图片文件拖到图表视图任意位置即复用现有上传通道；
      文件拖悬时显示虚线遮罩（enter/leave 深度计数器，`stopPropagation`
      避免宿主应用自己的文件拖放遮罩叠加），`filterDropFiles` 会报告
      不在接受列表内的文件而非静默忽略。
- [x] Wiki 导出/导入（备份与迁移）：新的 `exportWiki` /
      `importWiki` Remote（共 27 个 research 方法）把全部六张 wiki 表
      快照进一个带日期的 JSON 信封（`format: "mimir-wiki"`，
      `version: 2`）；导入在任何写入之前先对信封和每行按其表 zod schema
      重校验（坏快照不改变任何东西），`merge` 只 upsert 缺失的主键
      （已存在的记录被跳过、绝不覆写——保守优先），`replace` 先清空全部
      六张表，因此要求 `confirmReplace: true`。总览的新数据区块下载导出，
      并以摘要卡（每表行数）、merge/replace 选择（replace 触发红色二次
      确认）和 settle 后的导入/跳过计数引导导入，然后重新拉取每个已加载
      分片。
- [x] 定时 wiki 自动备份：宿主侧定时器（新的 `backup` 配置节——
      `enabled`/`intervalMinutes`/`keep`/`dir`，schemastery +
      resolveConfig 校验）经 `exportWiki` 所用的同一 `buildWikiSnapshot`
      构造器（抽到 wiki-snapshot.ts，无复制逻辑）给 wiki 拍快照，写入
      `<workspaceDir>/backups/mimir-wiki-YYYYMMDD-HHmmss.json`（UTC，
      故字典序 = 时间序），dsh-atomic-write 原子写，超出 `keep` 的最旧
      备份被清理；启动后一分钟首次执行（启动保持快速），两个定时器均
      unref，失败只告警并在下个周期重试，dispose 经插件 effect 生命周期
      清除定时器。新的 `listBackups` Remote（28 个方法）供总览数据区块的
      状态行使用（节奏 · keep · 磁盘数量，或"关闭"）；自动备份文件可经
      现有导入流程原样导回。
- [x] 面板 toast 通知：工作台右下角的角落堆叠
      （`toasts.ts` 纯队列规则——4 秒 TTL、4 张卡片上限丢弃最旧者，
      相同文案+详情的推送原位刷新而非叠放——加上带单个清扫定时器的
      `ToastHost` 渲染+定时组件，定时器对齐下一次到期）。toast 携带
      locale key，控制器保持 locale 无关；种类映射到绿/蓝/红强调色。
      触发点：编译成功/失败（带失败消息）、论文/文献/wiki 导入（带计数）、
      探测全部 settle、图表上传，以及每一次删除。

## 队列

### 服务器

- [ ] 经 SSH 提交远程任务（运行训练命令）+ 轮询任务状态
      ——需要用户提供真实服务器地址，否则只能演示

### 计划中的加固

- [ ] ledger 记录+事件提交的 file-locked 硬化（P2 加固）：在同一个文件锁
      下提交 ledger 记录与其事件，使"仅追加"成为硬保证（见
      `packages/mimir/src/ledger.ts` 中的自我备注）

### UI/UX 打磨轮

## 受阻（需要用户输入）

- 端到端任务提交测试所需的真实 GPU 服务器主机/凭据
- 模型驱动的 e2e（reviewer 循环、论文写作）所需 `DEEPSEEK_API_KEY`
