# 资源分析与提取

## 触发条件

需要包体侦察、资源分类、提取报告、候选文件或把现有专用工具接入统一中间层。

## 规则

- 优先包装已有解析器，不重写已经稳定的 Arcaea、Phigros、Rizline、In Falsus 工具。
- Adapter 输入可以不同，但输出必须是 Candidate/统一 Asset Manifest；上游的 source identity、provenance、诊断和选择策略不能泄漏到网站共享组件。
- `_optimization.png` 等人工处理文件必须保留在 workspace；不要默认把它当成最终发布格式。允许在人工确认后生成 JPEG 优化版本。

## 验证

对真实报告运行 `rhythmctl extract` 或 adapter 原有 CLI，检查输出的 source snapshot、候选数量、诊断和 workflow state；任何无法确认的身份都标记为 review/block，而不是猜测。
