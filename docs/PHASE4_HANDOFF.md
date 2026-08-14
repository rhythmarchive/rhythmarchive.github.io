# Phase 4 Handoff

## 状态

- Storage adapter: READY
- Catalog: READY
- Admin real publish: READY
- Legacy dry-run: COMPLETE
- ROS credentials: CONFIGURED LOCALLY; Canary previously PASS
- Real ROS Canary: PASS (user-run; not executed by this turn)
- Full Legacy Migration: NOT RUN

## 实现

1. `packages/domain/src/storage.ts` 使用 `@aws-sdk/client-s3`，支持 `putObject`、`headObject`、`getObject`、`deleteObject`、`objectExists` 和 `verifyObject`。Immutable Object 默认设置 `Cache-Control: public, max-age=31536000, immutable`。
2. `catalog/index.json` 是正式 Catalog；`catalog/releases/` 保存 ReleaseManifest。Catalog 不保存本机绝对路径、workspace 状态或 ROS credentials。
3. `executePublishPlan()` 先校验本地文件 hash，再按 Object 检查/上传/HEAD；Catalog 和 ReleaseManifest 都先生成、校验到临时文件，正式提交时先替换 ReleaseManifest、最后替换 Catalog，出错会恢复旧文件并清理临时文件。上传或提交失败时 workspace 保留，可继续重试。
4. Admin 发布页现在同时支持预览和真实发布；未配置 ROS 时显示 `ROS 凭据未配置。`，不会 crash 或显示 stack trace。
5. `packages/domain/src/thumbnails.ts` 保留 320 / 640 / 1280 WebP 生成能力；预览缩略图按 Resource/Variant 每个只生成一套，original + upscaled 时优先使用 upscaled 作为生成源；Legacy dry-run 只估算缩略图，不生成或上传文件。
6. 首次迁移使用 `scanFirstMigrationPlan()`：Arcaea jacket 来自 `E:\曲绘\Arcaea\曲绘`（含已整理 AI 配对），Arcaea non-jacket 来自当前本地 APK 快照，Phigros 继续使用 Legacy 规则。旧 Arcaea 非曲绘不进入正式 plan。
7. 复用旧项目 `scripts/extract-arcaea-update.ts` 的 APK 路径筛选、songlist/packlist/characters metadata、命名和资源分类；current snapshot 只保留非 jacket 候选，且不会写旧项目目录。
8. 本机 dry-run 统计如下：

   - Arcaea jacket：603 个 Resource，1206 个文件
   - Arcaea current APK non-jacket：1364 个
   - 资源：2468
   - 文件：3071
   - 源文件：2468
   - upscaled：603
   - Variant：57
   - 重复 Object（冗余引用）：35，重复 hash 组：26
   - 预计 ROS Object：10440
   - 预计上传：约 4.67 GiB（含缩略图估算）
   - 预计缩略图：约 1.58 GiB
   - 预览缩略图：7404 个；相较按每个文件生成三套，减少 1809 个 Object，预计上传减少 265226970 bytes
   - 无法自动识别：0
   - blockingIssues：0
   - warnings：380：`SPECIAL_DIFFICULTY_WARNING` 57，`PHIGROS_METADATA_WARNING` 294，`UNRESOLVED_256_WARNING` 3，`DUPLICATE_HASH_DIFFERENT_SEMANTICS` 26

   原图与 AI 配对按规范化 basename 完成；没有按 songId 合并 Resource，`_256` 保持 unresolved，Phigros 缺 metadata 不伪造。扫描没有修改源文件。

   当前 APK：`D:\Files\曲绘\Arcaea\APK\arcaea_6.16.0c.apk`（6.16.0）。旧 extractor 对同名剧情贴图输出增加了按 APK 相对路径的最小碰撞隔离，不改变 source identity。

## 安全检查

- `.env`、`.env.local`、`.env.production`、`.env.development`、`.env.test` 和 `.env.example` 均被 `.gitignore` 忽略。
- Admin 只返回 ROS endpoint、bucket、public URL 和 configured 布尔值，不返回 `accessKey` 或 `secretKey`。
- ROS key 只从 `ROS_ACCESS_KEY` / `ROS_SECRET_KEY` 环境变量读取。
- `ALLOW_FULL_LEGACY_MIGRATION` 默认 `0`；没有显式 `1` 不允许未来全量迁移。

## 验证

```text
npm run typecheck
npm test
npm run legacy:dry-run
```

当前测试：46/46 passed；typecheck passed；Legacy dry-run 完成且 `readOnly: true`。difficulty suffix 只对 Arcaea `jacket` 生效；剧情 CG、曲包封面等非曲绘资源不再产生 `SPECIAL_DIFFICULTY_WARNING`。本次未执行真实 ROS 请求。

用户可直接运行 `npm run ros:verify` 验证小体积 synthetic Canary；确认结果后再从 Admin 发布小批量 workspace。全量 Legacy Migration 仍需显式设置 `ALLOW_FULL_LEGACY_MIGRATION=1`，当前保持 `0`。
