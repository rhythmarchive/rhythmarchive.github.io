# Unified Platform

本仓库的统一边界分为三层：

```text
APK / 安装目录 / AssetBundle / Addressables / 远程资源
                         │
                    GameAdapter
                         │
       GameProfile + Candidate/Asset Manifest + diagnostics
                         │
          Catalog / PublicSiteData / SearchIndex
                         │
       shared pages, galleries, cards, search, release tooling
```

## 领域模型

+ `packages/domain/src/platform.ts` 定义正式 `GameProfile`、`GameRecord`、`AssetRecord`、只读 `SourceProbe`、能力 contract 和 Adapter extraction plan；`packages/domain/src/onboarding.ts` 负责尚未注册的 candidate probe，不改变正式 Catalog。
- `packages/domain/src/release.ts` 定义网站无关的 `UnifiedAssetManifest` 和 `ReleaseDelta`。稳定身份是 `game | assetType | sourceIdentity | variantKey`，差异严格输出 `NEW`、`CHANGED`、`REMOVED`、`UNCHANGED`。
- `packages/domain/src/review-package.ts` 把 Delta 变成人工审核 gate；删除永远不是批准的隐含副作用。
- `packages/domain/src/storage-diff.ts` 只比较 hash、size 和 object key，输出 `SAME`、`NEW`、`CHANGED`、`REMOVED` 与 `none/upload/review` 操作建议。
+ `packages/domain/src/workflow-state.ts` 在 `temp/rhythmctl/<game-or-candidate>/<version>/state.json` 保存 phase、snapshot、产物路径、审核状态、发布状态和 blocker，支持跨会话 status/resume。

正式网站仍以已验证的 `catalog/index.json` 和现有 browse projections 为事实来源。Arcaea、Phigros、Rizline、In Falsus 都通过共享 `[game]`/`[category]` 页面、共享卡片和同一搜索索引提供页面；Arcaea/Phigros/Rizline 的语义筛选保留在 projection adapter，不复制 UI 壳。

## 新游戏

未注册 candidate 先通过 onboard probe 完成 source kind、文件 inventory、引擎/runtime、markers、资产类型和 extractor feasibility 分析，再生成 DraftGameProfile 与 selection policy。只有明确决定接入后才建立正式 profile/adapter；提取结果进入 temp workspace，normalize 成候选 Manifest，经人工审核后才准备 release。发现但未选择的资源必须留在报告/诊断中。

## 已有游戏更新

读取上一正式 Manifest，复用已有 adapter；候选 Manifest 与上一版本比较。只有 adapter marker 或关键身份映射明显失效时才重新侦察。审核后只处理 NEW/CHANGED；REMOVED 进入人工确认，不触发远端删除。

## 兼容与安全

现有 Catalog resource/detail URL 和对象 key 优先保持不变；统一内部模型不要求移动远端文件。所有源目录只读，ROS/对象存储和 GitHub Pages 生产写入不属于本地改造范围。

Canonical current guidance is in docs/architecture.md, docs/workflows.md, docs/project-rules.md, docs/site-design.md, docs/catalog.md, and docs/storage.md.
