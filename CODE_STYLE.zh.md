# Mimir 代码规范

[English](CODE_STYLE.md) | 中文

所有 PR 共用的代码规范。条款全部提取自现有代码库——拿不准时，照抄你正在改的那个文件
的写法。流程类约定（分支、CI、截图 QA）在 [CONTRIBUTING.zh.md](CONTRIBUTING.zh.md)，
这份文件只管代码本身。

## 1. 总原则

- **纯逻辑与壳分离。** 解析、计算、映射、布局算法住在纯模块里（无 DOM、无副作用：
  `venue-deadlines.ts`、`live-refresh.ts`、`paper-layout.ts`）；I/O、定时器、ctx 接线
  住在薄薄的服务/controller 壳里。不 mock 就没法单测的代码，说明放错了层。
- **读路径 fail-open，写路径 fail-loud。** 缓存坏了、记录脏了，降级成"没数据"——
  面板照常打开。过不了校验的写，在碰到磁盘之前拒绝。
- **融入你所在的文件。** 不顺手重排版，不从别的项目搬个人习惯。

## 2. TypeScript

- 每个模块以 JSDoc 块开头，讲清**做什么和为什么**，以 `@module <包名>/src/<路径>` 结尾。
- 每个导出符号都有 JSDoc。写意图和不变量，不写废话；接口的字段逐个注释。
- 默认不可变：`readonly` 字段、`readonly T[]` 数组、共享常量 `Object.freeze`。
  能用 fold 就不用 `let`。
- 禁止 `any`。边界处没类型（remote stub、JSON.parse）就用 schema 收窄，
  或显式 `unknown` + 检查。
- 数据用 interface 不用 class；构造用 `createX` 工厂，返回只读方法接口，
  不暴露 public 字段。

## 3. 错误与校验

- 在边界校验（zod schema、`isValidArxivId` 式断言函数），内部信任类型。
- **schema 只许增量变更。** wiki 域永远停在 version 2：新字段必须可选或带
  `.default(...)`；新表对旧快照空开。加载时绝不硬拒存量记录形状——对存储数据加
  `.refine` 等于让有历史脏数据的用户启动即崩。加载时清洗，写入时严格。
- Remote 错误用类型化错误码（`invalid-input`、`project-not-found`……），
  不透出原始异常文本。错误信息里不许出现密钥、token、绝对路径。

## 4. 异步与并发

- 每条异步加载路径都走 **generation + pending 模式**：每个 slice 一个 generation
  计数器，`select()` 时 bump；迟到的过期响应直接丢弃；在途请求用 pending 合并重放。
  参考实现：`controller.ts` 里的 `venuesGeneration`。
- await 之后发布状态前，必须重新确认世界还是出发时的那个（项目没切走、组件没销毁）。
- 每个定时器、监听器、EventSource、interval 都有配对的清理（`dispose()` /
  effect teardown）。宿主侧定时器要 unref。
- 文件的读-改-写必须走文件锁 / single-flight 辅助函数；写同一个文件的两条路径
  必须都持锁。

## 5. 安全红线

- 任何用户或模型可控的字符串，进文件路径前先过白名单（字符集 + 拒 `..` +
  拒绝对路径）。shell 参数同理——用 `execFile`，绝不拼字符串，用户数据前加 `--`。
- 所有 CSS 颜色走 `var(--token, fallback)`，暗色模式才跟得上宿主主题。
  裸 `var(--x)` 没有 fallback 的写法让我们栽过。
- 永不记录或外发 API key；错误信息里要脱敏。

## 6. UI（ui-mimir）

- controller **不感知语言**：toast 和视图拿 locale key，不拿字符串。加一条文案 =
  中英各加一条；`locales.spec.ts` 会强制对齐。
- 可交互元素必须有 `aria-label`；按钮统一走 `.btn` / `.btnPrimary` 基类，
  不发明一次性按钮样式。
- 可点击区域 ≥ 28px；要紧凑，不要小到点不中。
- 持久化的 UI 状态（localStorage，`mimir.*` 键）必须通过 codec 读取
  （try/catch + clamp）；脏数据、旧版本数据绝不能让首渲染崩掉。
- UI 改动必须带截图。"看着没问题"的意思是真的看过。

## 7. 测试

- 新行为必须在同一个 PR 里带 vitest 用例。纯逻辑单测；controller 契约用
  stubbed-remote 测试。
- 解析器必须用真实世界样本做 round-trip（样本放 `tests/fixtures/`）。
- 修 bug 必须带一个"没有修复就会红"的回归测试。
- `pnpm run build && pnpm run typecheck && pnpm test` 保持全绿。
  不许 `it.skip`、`.only`、注释掉的测试。

## 8. 提交与 PR

- 英文、祈使句、一行摘要；需要背景时加一段正文。`git log` 就是语气范本。
- PR 一律用 **merge commit** 合入（不要 squash）——署名必须留在 contributors 图谱里。
- PR 描述回答三个问题：没有它会怎样、怎么测的、UI 改动附截图。
- 文档跟代码一起走：`README.md` 与 `README.zh.md` 逐节对齐；计划变了就更新
  `ROADMAP.md` / `ROADMAP.zh.md`。
