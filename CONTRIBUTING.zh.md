# Mimir 贡献指南

[English](CONTRIBUTING.md) | 中文

感谢一起共创 Mimir！本文档说明协作流程、每个改动必须过的检查、以及之前踩过的坑。
代码层面的约定在 [CODE_STYLE.zh.md](CODE_STYLE.zh.md)——提第一个 PR 前请先读它。

## 环境搭建

```bash
git clone https://github.com/1692775560/dsh-Mimir-Academic-research.git
cd Mimir
pnpm install
pnpm run build   # 有序构建：mimir tsc+bundle，然后 ui-mimir tsc+bundle
pnpm test        # vitest，必须保持全绿
```

已在 Node v24 / pnpm v11 上验证。启动示例 agent 和 Web 工作台见 [README](README.zh.md) 的 Quickstart。

## 分支约定

- `main` —— 稳定发布分支，只接受 PR 合并。
- `dev` —— 集成分支，日常开发提到这里。
- `feature/<名字>` / `fix/<名字>` / `docs/<名字>` —— 你的分支，从 `dev` 切出，PR 回 `dev`。

动手前先在对应 Issue 下评论认领，避免撞车。

## 每个 PR 必须

1. CI 全绿（`install → build → typecheck → test`）。新行为要补测试——纯逻辑抽成可测函数，别内联在组件里。
2. **UI 改动**：跑截图 QA（本地起 `examples/mimir-agent` 服务后用 `packages/ui-mimir/scripts/screenshot.ts`），逐张目检，相关截图附到 PR 里。「看着没问题」必须是真的看过。
3. 更新受影响的文档：`README.md` 和 `README.zh.md` 保持逐节对齐，`ROADMAP.md` 保持最新。
4. 跟随所在文件的既有风格（JSDoc、`readonly`、`Object.freeze`、CSS 颜色一律 `var(--x, 兜底)`）。

## 坑（都是真踩过的）

- **只加 `@Remote` 方法不够。** Web 客户端走生成代码，dsh 的 api-remotes bundle 里内嵌了方法清单；本仓库 `pnpm run build` 会自动重新生成，但在 dsh 检出里开发时必须重建 host 和 client 两个 face，否则浏览器报 `this.remote.<方法> is not a function`。
- **wiki domain 版本保持 2。** 没有迁移机制，bump 版本会让所有已有用户数据打不开。新字段必须可选或带 `.default(...)`；新表在旧数据上打开即为空。加一个旧格式记录的兼容性测试。
- **所有 CSS 颜色走 `var(--dsw-*, 兜底)`**，深色模式才能跟随宿主主题。曾经有人写裸 `var(--x)` 没兜底，整个面板全白。
- **别动 overlay/textarea 的几何对齐。** 语法高亮 overlay 和 textarea 共享完全相同的字体度量；动一边必须截编辑器图检查有没有重影。

## Commit message

英文、祈使句，一行摘要，需要背景时加简短正文。风格参考 `git log`。
