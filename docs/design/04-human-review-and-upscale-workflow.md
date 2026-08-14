# Human Review and AI Upscale Workflow

## 1. Candidate 不是三态审核记录

Candidate 是本地批次中“一个抽取/手工加入的文件候选”的稳定工作单元。它同时保存：

- `id`：UUIDv7，改名后不变；
- `batchId` 和 `sourceEvidence`：`legacy`、`arcaea_apk`、`phigros_apk`、`manual` 及 source relative path、源 filename、版本、hash、检测原因和证据；
- `naming`：`sourceFilename`、`suggestedFilename`、`reviewedFilename`、`finalFilename`、已知 basename aliases；
- `suggestedMapping`：自动建议的 resourceType、title、variantKey、external identities、metadata、confidence 和证据；
- `files[]`：raw-original、work-original、upscale-input、upscale-output、processed-upscaled 等 CandidateFile；
- `review`：命名审核状态、最终审核状态、ReviewDecision 和备注；
- `processing`：是否需要超分、输入/输出/processed 文件关系、转换参数和 source PNG 保留事实；
- `target`：人工确认后才填充的 Resource/Variant/Rendition 引用。

因此自动命名只是 suggestion，人工改名也不会制造一个新 Candidate，更不会通过 filename 重新计算 Resource ID。

## 2. Candidate 状态

聚合状态用于未来 UI 显示；review/processing 两个子状态保留更精细的事实。原型支持：

```text
EXTRACTED
   ↓
NAMING_REVIEW
   ├─ NEEDS_UPSCALE → UPSCALE_PENDING → UPSCALE_DETECTED → UPSCALE_CONVERTED
   │                                                            ↓
   └──────────────────────────────────────────────────────→ FINAL_REVIEW
                                                              ├─ READY
                                                              ├─ REJECTED
                                                              └─ BLOCKED
```

允许 `BLOCKED` 回到人工可处理的阶段；`READY`、`REJECTED` 是本批次该 Candidate 的终态。若不需要超分，可以从 `NAMING_REVIEW` 直接进入 `FINAL_REVIEW`。一个 Candidate 可以有多个 `upscale-output` attempts，但在选定一个 output 前不得进入 READY。

ReviewDecision 不简化成 accepted/rejected，原型包括：

- `accept-existing-resource`；
- `accept-new-resource`；
- `accept-new-variant`；
- `accept-new-rendition`；
- `alias-candidate`；
- `reject`；
- `needs-metadata`；
- `block`。

Phigros key 无法证明既有 bundle 内容变化时，Candidate 必须保持 `BLOCKED` 或 `needs-metadata`，不能因为文件名看起来合理而自动建立强关系。

## 3. UpdateBatch 总体状态和进度

UpdateBatch 状态保持有限：`CREATED → EXTRACTED → IN_REVIEW → PROCESSING → READY_TO_PUBLISH → PUBLISHED → CLEANED`，任何阶段可进入 `BLOCKED`，处理后回到可审核阶段。Batch 另存：

- 文件名审核：`total/completed/blocked`；
- AI 超分：只统计 `requiresUpscale` 的 Candidate；
- 最终确认：`total/completed/blocked`。

这样未来界面可以直接显示：

```text
Arcaea 6.17.0
文件名审核：21 / 23
AI 超分：8 / 11
最终确认：19 / 23
还有 4 项未完成
```

这些计数是 local batch 的状态投影，不写入正式 Catalog。

## 4. 人工改名合同

改名顺序：

```text
raw source filename
       ↓ extractor suggestion
suggested filename
       ↓ human correction
reviewed filename
       ↓ final review / processed output
final filename
```

`renameCandidate()` 只更新 Candidate naming 和 aliases，保留 `candidate.id`、source file provenance、原始文件 hash 和 raw 路径。Windows 文件名校验只针对真正文件名，不把 `/`、`\\` 或绝对路径写进 CandidateFile。

重新扫描超分输出时，匹配优先使用 batch manifest/Candidate ID，文件名只作为外部工具没有 sidecar 时的兼容线索。实现会把 source/suggested/reviewed/final basename 都归一化为 NFC、小写和无扩展名 stem；因此原图由 `Testify.jpg` 改为 `Testify Reviewed.jpg` 后，`Testify Reviewed_optimization.png` 仍能匹配同一个 Candidate。无法唯一匹配则返回 `ambiguous`/`unmatched`，交给人工。

## 5. AI 超分的人工边界

系统只做准备、发现、登记和转换，不启动或控制用户的 AI 工具：

1. 人工在 `work/` 确认原图和 final filename；
2. 复制到 `upscale-input/`，记录 input CandidateFile；
3. 用户自行生成 `<basename>_optimization.png` 放入 `upscale-output/`；
4. 系统重扫并登记 output，匹配关系写入 processing；
5. 人工查看 output，多个 output 时明确选择一个；
6. converter 生成 `processed/` JPEG；
7. 人工做最终视觉、metadata、Resource/Variant/Rendition 关系审核；
8. Candidate 才能进入 READY，并进入 ReleaseManifest。

同一个 original 可以暂时对应多个 optimization attempts，用于比较外部工具结果；它不能自动变成多个 upscaled rendition。若确实要发布多个不同表现，必须创建独立、人工命名和说明的 Rendition 记录。

## 6. 来源差异不被统一模型抹平

四种 Candidate source 共用 Candidate/Review/Processing 结构，但保留各自 evidence：

- `legacy`：历史相对路径、旧索引、hash/alias 证据；
- `arcaea_apk`：old/new APK、APK 内相对路径、path diff、metadata evidence；
- `phigros_apk`：Addressables key、bundle、Texture2D object、nameSource 和 changed-bundle 不确定性；
- `manual`：用户明确输入、备注和创建时间。

统一的是审核合同，不是把所有来源当作同等可信，也不是强迫 Phigros 使用 Arcaea 的 difficulty/AI 假设。
