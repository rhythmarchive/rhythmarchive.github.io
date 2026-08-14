# Local Version Workspace

## 1. 目标

Version Workspace 是本版本更新文件集合的真实 Windows 文件工作区，不是数据库里一组抽象 Candidate。示例：

```text
E:\rhythm-assets-gallery-v2\.runtime\updates\arcaea\6.17.0\
├─ raw\
├─ work\
├─ upscale-input\
├─ upscale-output\
├─ processed\
└─ metadata\
   └─ batch.json
```

本阶段实现 `ensureWorkspaceLayout()` 和 `writeBatchManifest()`，测试会在临时目录真正创建这些目录。未来 extractor 只需要把 `raw/` 写成候选文件，并在 `metadata/batch.json` 登记 Candidate ID；它不需要把结果先塞进 SQLite 才能被用户浏览。

## 2. 目录合同

| 目录 | 所有者 | 允许的操作 | 生命周期 |
|---|---|---|---|
| `raw/` | extractor | 写入原始抽取结果；后续只读 | batch 存在期间保留，发布验证后可按政策归档/清理 |
| `work/` | 人工维护 | 改名、整理、移除候选、补充文件 | 审核期间主要工作区 |
| `upscale-input/` | 人工准备 | 放入交给外部 AI 工具的输入副本 | 超分完成且核对后可清理，但需留 manifest |
| `upscale-output/` | 外部 AI 工具/人工复制 | 放入 `<basename>_optimization.png` | 转换和最终确认前必须保留 |
| `processed/` | V2 converter | 写入经过验证的最终 staging JPG | PublishPlan 之前可重复生成 |
| `metadata/` | V2 原型 | `batch.json`、Candidate/扫描/转换报告 | 作为恢复与审计依据 |

`raw/` 不接受人工直接改名。人工修改只在 `work/` 发生，源文件和 source filename 永远可回看。`processed/` 不是长期归档，也不代表已经上传。

## 3. APK 和 workspace provenance

UpdateBatch 至少记录：`game`、`targetVersion`、`baseVersion`、local old/new APK filename、绝对路径、可选 SHA-256、验证状态、创建时间、extractor version、workspace root、Candidate IDs、三个进度计数和 batch status。绝对路径只属于 local UpdateBatch state；不得复制到 Catalog。

本地流程的数据流是：

```text
用户选择 old.apk + new.apk
  → 本地 extractor（Phase 2A 不实现）
  → raw/ + CandidateManifest
  → work/ 人工命名与分类
  → upscale-input/ 外部 AI
  → upscale-output/ 重新扫描
  → processed/ 非破坏性转换
  → Final Review
  → ReleaseManifest + dry-run PublishPlan
```

它不读取 ROS latest/previous APK，不从网站下载 APK，也不调用 GitHub Actions。

## 4. `upscale-input` 的 Windows 选择

默认采用普通文件复制。它最容易解释、可跨卷、可被外部 AI 软件正常打开，原文件和副本的破坏半径清晰。

- 硬链接节省磁盘，但两个目录共享同一 file record；外部工具覆盖或删除其中一个路径可能直接影响原文件，跨卷也不可用。除非用户明确选择并完成同卷/权限检查，不能默认采用。
- 符号链接依赖 Windows Developer Mode/管理员策略，外部 GUI 工具、压缩软件和备份工具对链接的处理不一致，断链后恢复困难，也可能越过 workspace 边界。
- 复制有额外空间成本，但符合本阶段“安全、容易理解、可恢复”优先级。空间优化以后可作为显式高级选项，不能改变 Candidate provenance。

## 5. 重扫和恢复

扫描 `work/` 或 `upscale-output/` 时，系统先加载 `batch.json` 与 Candidate 的 filename aliases，再进行文件名匹配。Candidate ID 不由当前文件名重算；改名后仍用旧 source/suggested/reviewed/final aliases 和 manifest 记录恢复关系。一个 output 无法唯一匹配时进入 `BLOCKED`/人工处理，而不是猜测。

`metadata/batch.json` 用临时文件写入后 rename，避免进程中断时覆盖完整 manifest。任何转换失败都只影响 staging 临时输出，保留 raw、work 和 PNG。

## 6. 完成定义

只有以下条件都满足，Workspace 才能从 `READY_TO_PUBLISH` 进入后续 PublishRun：所有要发布的 Candidate 有最终文件、对象 hash/尺寸验证通过、ReleaseManifest 和 PublishPlan 可审阅、人工确认完成。`CLEANED` 不表示“转换成功”，而表示未来发布成功、ROS 对象验证成功、Catalog commit 成功之后允许按政策清理 staging。
