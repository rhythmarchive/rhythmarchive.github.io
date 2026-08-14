# Phase 2B supersession note

This Phase 2A handoff is historical. Phase 2B keeps compatibility reads for its fixtures but supersedes the unified schema/version, ReleaseManifest ignored-candidate boundary, display filename and raw-integrity assumptions. The current contracts are documented in `docs/design/phase2b/`.

# Phase 2A Handoff

日期：2026-08-14  
状态：**Phase 2A COMPLETE — STOPPED BEFORE SCANNER / ADMIN / ROS IMPLEMENTATION**

## 1. 已完成内容

本阶段在 `E:\rhythm-assets-gallery-v2` 内完成了 V2 数据合同原型：

- `packages/domain/src/schema.ts`：TypeScript + Zod schema，固定 `schemaVersion: "1.0"`，包含 CandidateManifest 外壳；
- `packages/domain/src/validation.ts`：单实体 runtime validation、Catalog 外键/路径校验、ReleaseManifest/PublishPlan consistency；
- `packages/domain/src/identity.ts`：UUIDv7、Object hash/objectKey、filename normalization、Candidate rename；
- `packages/domain/src/workflow.ts`：Version Workspace 目录助手、manifest atomic write、Candidate/Batch state transitions；
- `packages/domain/src/upscale.ts`：optimization discovery/matching、alpha detection、非破坏性 Sharp JPEG conversion；
- `fixtures/phase2a/`：Phase 1 真实高风险案例、CandidateManifest、合法/非法合同 fixtures 和转换图片 fixture；
- `packages/domain/tests/domain.test.ts`：自动测试；
- `docs/design/01-domain-model.md` 到 `08-fixture-coverage.md`：设计合同；
- `docs/design/upscale-experiment-2026-08-14.json`：实际转换实验报告。

安装依赖后可运行：

```text
npm run typecheck
npm test
npm run experiment:upscale
```

最后一次验证结果：TypeScript typecheck 通过，自动测试 **12/12 passed**。

## 2. 最终 Resource identity 方案

- Resource、Variant、Rendition、Candidate：生成并持久化的 RFC 9562 UUIDv7 opaque ID；
- Object：`id=sha256:<digest>`，Object bytes 改变就创建新 Object；
- ROS key 未来使用 `objects/<sha256>/<extension>`，与 Resource URL 解耦；
- songId、characterId、storyNode、Phigros key 只作为 ExternalIdentity；
- filename、title、relativePath、objectKey 都不是永久 Resource primary key；
- 同 hash 可以共享 Object，但绝不自动合并语义 Resource。

UUIDv7 是推荐方案；ULID 是可替代的时间有序 opaque 方案；带 namespace 的 deterministic ID 只可作为审计候选键，不能默认承担永久身份，因为 Phase 1 已证明输入语义有歧义。

## 3. Version Workspace

```text
.runtime/updates/<game>/<targetVersion>/
├─ raw/             # extractor output, immutable-by-contract
├─ work/            # human rename/classification/review
├─ upscale-input/   # safe regular-file copies
├─ upscale-output/  # external <basename>_optimization.png
├─ processed/       # validated staging JPEG
└─ metadata/batch.json
```

Workspace 是真实文件目录，用户可直接打开、浏览、改名、放入 AI 输出。普通复制是默认的 upscale-input 方案；硬链接/符号链接的 Windows 风险已写入设计文档，未作为默认优化。

`raw/` 不直接改名，`work/` 产生人工版本。Batch manifest 保存本地绝对路径和状态，正式 Catalog 只保存可迁移 relative path/hash/provenance。

## 4. 人工文件改名和 identity

Candidate 保存 `sourceFilename`、`suggestedFilename`、`reviewedFilename`、`finalFilename` 和 aliases。默认 `renameCandidate()` 只写 reviewed filename；明确 finalize 才写 final filename，不改变 Candidate ID，也不改变 Resource/Variant/Rendition ID。重新发现 `_optimization.png` 时，系统优先接受可选 sidecar mapping，再用所有已知 basename 关联 Candidate；一个 output 命中多个 Candidate 或没有命中时阻塞人工，不猜测。

## 5. AI 超分工作流

```text
EXTRACTED
 → NAMING_REVIEW
 → NEEDS_UPSCALE
 → UPSCALE_PENDING
 → UPSCALE_DETECTED
 → UPSCALE_CONVERTED
 → FINAL_REVIEW
 → READY
```

不自动调用 AI 工具。用户负责外部超分，系统负责复制输入、发现输出、登记匹配、处理多个 attempts、转换和最终验证。`upscaled` 是同一 Variant 下的 derived、publishable Rendition；不通过 `_opt` 文件名判断类型。

## 6. `_optimization.png → JPG` 推荐和结果

推荐 baseline：Sharp、sRGB、quality **95**、4:4:4、progressive、mozjpeg=false。该参数继承旧真实实现中有价值的 quality/chroma 思路，但移除默认 destructive delete。

本轮 V2 派生 fixture 的输入 PNG 为 17,965,264 B、3072×3072：

- q92：3,843,988 B，节省 78.60%，MAE 1.2216，max 41；
- q95：4,498,957 B，节省 74.96%，MAE 0.1380，max 8；
- q97：5,268,025 B，节省 70.68%，MAE 0.4515，max 14。

高层视觉检查未见明显 artifact；q95 在本样本中提供了较低的基础像素差异和明显体积下降，因此作为 baseline。结果不是对所有外部 AI PNG 的保证，仍需人工 final review。

透明 PNG 默认检测到实际 alpha 后 **block**；只有明确 `flatten-white`/`flatten-explicit` 才转换。输出必须是 `processed/` 下的 JPG，输入输出同路径会被拒绝；转换写入 partial 文件、验证后以可恢复方式替换 output，永远保留源 PNG；只有未来 PublishRun + ROS verification + Catalog commit 成功并经批准，才允许 staging cleanup。

## 7. ReleaseManifest 和 PublishPlan

ReleaseManifest 是版本级事实，记录 added Resource、added Variant、added/upgraded/replaced Rendition、metadata changed、alias added、ignored Candidate 和最终发布 Rendition 集合。它不是 filesystem snapshot，未来即使 staging 清理仍可根据 Catalog + Manifest + ROS 回答版本更新内容。

PublishPlan 只做 dry-run 合同，包含 `objectsToCreate`、`catalogMutations`、`releaseManifestMutation`、`objectsEligibleForGC`。未来顺序固定为：validate → create Objects → verify Objects → mutate Catalog → commit/push → Pages deploy → retention/GC → cleanup staging。Phase 2A 不执行其中任何 ROS/Catalog/Pages 动作。

## 8. 真实高风险 fixtures

已覆盖：

- 普通 Arcaea original/upscaled；
- base + BYD；
- 7 个三视觉 Variant songId 中至少 Ävril、Stasis 两个；
- `_0/_1/_2/_3`；
- `_256` unresolved；
- 多尺寸 original/AI pairing（真实 Acid God、Ävril、Asgore `_256` records，后者语义仍 unresolved）；
- 19 组/39 文件同 hash 中的跨语义和重命名案例；
- 短别名无法可靠映射 songId；
- Character portrait/avatar/LinkPlay preview；
- Story CG；
- Phigros 普通曲绘、改名同 hash、April Fools、缺失 artist/版本 metadata；
- `_optimization.png` 配对、转换和 alpha 拦截。

## 9. Unresolved semantics

以下事实仍然保持 unresolved，未被 schema 强行定性：

- `_256` 是独立 Variant、Rendition 还是历史兼容内容；
- ETR metadata 与实际独立曲绘的关系；
- 同 hash 不同路径在产品上是否多个页面入口还是 alias；
- Arcaea 历史主目录每个文件的精确 APK source version；
- 剧情 CG 与剧情贴图的完整边界；
- Phigros archive-only 内容的真实版本和 changed bundle 内资源关系；
- ROS 删除、retention、tombstone、rollback 的最终政策。

## 10. 明确停止边界

### Public Arcaea APK Distribution — OUT OF SCOPE

未来独立系统是：

```text
official Arcaea source
  → cloud scheduled checker
  → Rainyun ROS APK object
  → public site download
```

它不参与 `local resource extraction`，不参与 UpdateBatch，不参与 CandidateManifest，不为 local extractor 提供 APK。本阶段没有实现或连接它，也没有把 latest/previous 云端 APK 接回本地图片更新流程。

本阶段同样没有开发 Astro 公共网站、Admin WebUI、Rainyun ROS、GitHub Pages、GitHub Actions、云端 APK checker、正式 Legacy Migration、正式资源上传、正式 Catalog 生成或正式 extractor 重写。

**PHASE 2A COMPLETE — STOPPED BEFORE SCANNER / ADMIN / ROS IMPLEMENTATION**
