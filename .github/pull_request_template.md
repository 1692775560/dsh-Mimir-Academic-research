<!--
本仓库只合并真正解决问题且符合 CODE_STYLE.md 的 PR。
门禁 `node scripts/check-style.mjs`（CI build-test 必过项）+ 下方清单逐项确认。
Thanks for contributing! Every box below maps to a CODE_STYLE.md clause — please check them honestly.
-->

## 改动内容

<!-- 简述做了什么、为什么；说明"没有这个 PR 会坏什么"。关联 Issue：Closes #xx -->

## 检查清单

- [ ] **范围聚焦**：只做 Issue 要求的事，无顺手重构、无整文件行尾翻转（CODE_STYLE §1「Match the file you're in」；EOL 翻转会被 `no-crlf` 门禁拦下）
- [ ] **纯逻辑分离**：解析/计算/映射抽在 DOM-free 纯模块，I/O 和 ctx 接线留在薄壳层（CODE_STYLE §1）
- [ ] **测试**：新行为带 vitest 用例；bug 修复带"没有本修复必失败"的回归测试；无 `it.skip`/`.only`（CODE_STYLE §7）
- [ ] **安全红线自查**：用户/模型可控的字符串进入文件路径或 shell 参数前已过白名单；CSS 颜色均带 fallback（CODE_STYLE §5）
- [ ] **涉及 UI**：已跑截图 QA 并逐张目检，截图附在下方（CODE_STYLE §6）
- [ ] **门禁全绿**：`pnpm run build && pnpm run typecheck && pnpm test && pnpm run check-style` 本地全过
- [ ] **文档随代码走**：README.md / README.zh.md 逐节对齐；ROADMAP 双语同步（如涉及队列条目）（CODE_STYLE §8）
- [ ] **合并方式知悉**：维护者将以 merge commit 合并（非 squash），请保持提交历史干净、署名正确（CODE_STYLE §8）
- [ ] 涉及 `@Remote` 新增：已确认生成 face 重建（本仓库 `pnpm run build` 会处理）

## 测试证据

<!-- 贴测试/命令的输出摘要；UI 改动必填截图 -->

## 截图

<!-- UI 改动必填 -->
