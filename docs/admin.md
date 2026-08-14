# Local Admin

## 启动

在仓库根目录执行：

```text
npm install
npm run admin
```

默认地址是 `http://127.0.0.1:4173`。服务只监听 `127.0.0.1`，不接受公网 Host，也没有开放 CORS。

## ROS

本地 `.env` 使用以下环境变量；`.env*` 都被 Git 忽略，不能提交：

```text
ROS_ENDPOINT=https://cn-nb1.rains3.com
ROS_BUCKET=rhythm-assets
ROS_PUBLIC_BASE_URL=https://rhythm-assets.cn-nb1.rains3.com
ROS_ACCESS_KEY=
ROS_SECRET_KEY=
ALLOW_FULL_LEGACY_MIGRATION=0
```

Access Key / Secret Key 只从环境变量读取，不进入 Catalog、workspace manifest、`.runtime/admin-config.json` 或 Admin 响应。没有凭据时 Admin 仍可审核、超分、首次迁移和生成发布预览；点击发布时会显示“ROS 凭据未配置”。

## 配置目录

打开“设置”填写：

- Arcaea APK 本地目录
- Phigros APK 本地目录
- workspace/runtime 路径
- 旧项目提取器根目录（需要包含 `scripts/extract-arcaea-update.ts` 和/或 `scripts/extract-phigros-update.py`）
- Legacy Asset Root（默认 `E:\曲绘`，只读）
- Catalog JSON（默认 `catalog/index.json`）

配置保存在 `.runtime/admin-config.json`。也可以在启动前使用 `ARCAEA_APK_DIR`、`PHIGROS_APK_DIR`、`WORKSPACE_RUNTIME_PATH`、`LEGACY_ASSET_ROOT`、`LEGACY_PROJECT_ROOT` 和 `CATALOG_PATH` 环境变量提供初始值。

Legacy Asset Root 只作为迁移/查看来源，不是日常版本归档目录。新工作区只写入配置的 runtime 路径。

## 基本流程

1. 在“新建更新”选择游戏、旧 APK 和新 APK。
2. Admin 调用已配置的旧项目提取器，再通过 Phase 2C adapter 生成 Candidate 并创建 Version Workspace。
3. 在“更新审核”确认正常候选；Phigros 缺少曲名、曲师或文件名时，展开“补充信息”后再保存。
4. 在“AI 超分”准备 `upscale-input/`，自行运行外部工具，把 `*_optimization.png` 放入 `upscale-output/`，然后重新扫描、选择输出、转换 JPG。
5. 在“发布”生成预览；ROS 已配置后才可执行上传。对象使用 immutable SHA-256 key，重复 Object 会跳过。

## 首次迁移

“首次迁移”页面只读扫描：Arcaea 曲绘使用 `E:\曲绘\Arcaea\曲绘` 和已整理的 AI 配对目录；Arcaea 其他图片使用设置中当前 APK 目录里的最新本地 APK；Phigros 继续使用现有 Legacy 规则。旧 Arcaea 非曲绘不会进入正式计划。没有 APK 时显示“未找到 Arcaea APK。”

命令行 dry-run：

```text
npm run legacy:dry-run
```

Arcaea original / AI 使用规范化文件名配对；songId 不直接作为 Resource。只有 Arcaea jacket 允许 AI 超分和 difficulty suffix；剧情、角色、曲包封面、背景等非曲绘只保留 current APK source/original。无法识别游戏或资源类型、无法唯一关联 Resource、无法安全配对的项目进入 `blockingIssues`；Phigros metadata 不完整、特殊 difficulty、`_256` 和同 hash 不同语义保留为 `warnings`，不会阻塞迁移。缩略图规格为 320 / 640 / 1280 WebP，每个 Resource/Variant 只生成一套；original + upscaled 时优先使用 upscaled 作为预览源。dry-run 只估算，不生成或上传。

完整历史上传必须先主动设置：

```text
ALLOW_FULL_LEGACY_MIGRATION=1
```

默认值 `0`，本阶段不执行全量迁移。

## 发布与 Canary

正式 Catalog 在 `catalog/index.json`，ReleaseManifest 写入 `catalog/releases/`。发布顺序是校验、检查/上传 Object、HEAD 验证，然后把已校验的 Catalog 和 ReleaseManifest 写入临时文件；正式提交时先替换 ReleaseManifest、最后替换 Catalog，出错会恢复旧文件并清理临时文件。失败时保留 workspace，已上传的 immutable Object 可在重试时跳过。旧 Object 只记录 GC candidate，不自动删除。

凭据填写后可运行：

```text
npm run ros:verify
```

`ros:verify` 不依赖 Catalog、workspace 或 `E:\曲绘`：会在 `.runtime/ros-canary/` 生成一个 64x64 WebP，使用 `_canary/<sha256>.webp` 做 PUT、HEAD、Content-Length、实际 Cache-Control、公网 GET、Range、CORS 和重复检查，最后只删除这个 Canary Object。CORS 或 Range 不可用时会保留基础连通性结果并显示 warning。

工作区使用 Phase 2B 的 JSON manifest。重启 Admin 后会重新扫描 runtime 目录并继续已有工作区。
