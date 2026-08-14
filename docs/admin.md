# Local Admin

## 启动

在仓库根目录执行：

```text
npm install
npm run admin
```

默认地址是 `http://127.0.0.1:4173`。服务只监听 `127.0.0.1`，不接受公网 Host，也没有开放 CORS。

## 配置目录

打开“设置”填写：

- Arcaea APK 本地目录
- Phigros APK 本地目录
- workspace/runtime 路径
- 旧项目提取器根目录（需要包含 `scripts/extract-arcaea-update.ts` 和/或 `scripts/extract-phigros-update.py`）
- 可选的 Legacy Asset Root
- 可选的 Catalog JSON

配置保存在 `.runtime/admin-config.json`。也可以在启动前使用 `ARCAEA_APK_DIR`、`PHIGROS_APK_DIR`、`WORKSPACE_RUNTIME_PATH`、`LEGACY_ASSET_ROOT`、`LEGACY_PROJECT_ROOT` 和 `CATALOG_PATH` 环境变量提供初始值。

Legacy Asset Root 只作为迁移/查看来源，不是日常版本归档目录。新工作区只写入配置的 runtime 路径。

## 基本流程

1. 在“新建更新”选择游戏、旧 APK 和新 APK。
2. Admin 调用已配置的旧项目提取器，再通过 Phase 2C adapter 生成 Candidate 并创建 Version Workspace。
3. 在“更新审核”确认正常候选；Phigros 缺少曲名、曲师或文件名时，展开“补充信息”后再保存。
4. 在“AI 超分”准备 `upscale-input/`，自行运行外部工具，把 `*_optimization.png` 放入 `upscale-output/`，然后重新扫描、选择输出、转换 JPG。
5. 在“发布预览”生成 PublishPlan dry-run。当前不会连接 ROS、上传或发布。

工作区使用 Phase 2B 的 JSON manifest。重启 Admin 后会重新扫描 runtime 目录并继续已有工作区。
