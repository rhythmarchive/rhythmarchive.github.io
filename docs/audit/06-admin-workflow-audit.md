# Admin WebUI 工作流审计与范围建议

## 1. 核心结论

旧项目的真实维护成本不是 CRUD，而是候选资源的身份判断、去重、原图/AI/特殊难度关系、稀疏 metadata 补全、人工审核和安全发布。Admin 应围绕 UpdateRun、CandidateFile、ReviewDecision、ResourceGraph、PublishPlan、PublishRun 和 AuditEvent 组织。

## 2. MVP 必需页面

### Dashboard

- Catalog 的 Resource、Variant、Rendition 数量。
- 待审核更新、候选文件和阻塞原因。
- APK latest/previous、hash、验证状态、最后检查时间。
- ROS 配置是否存在、最近对象验证结果、最近 PublishRun。
- staging 磁盘占用和可清理批次。

### 更新中心

- 展示 Arcaea APK diff、Phigros Addressables、Legacy migration 的批次。
- 每个候选显示预览、尺寸、hash、sourcePath、sourceVersion、解析字段和置信度。
- 对照旧 Catalog 展示 added、changed、same-hash alias、unmapped、possibly-deleted。
- 支持修改游戏、resourceType/category、title、artist、songId、characterId、pack、story、difficulty、side、background。
- 支持明确动作：接受为现有 Resource 的新 rendition、现有 Resource 的新 Variant、新建 Resource、合并 alias、拒绝、待补 metadata。
- 特殊难度显示 base、_0、_1、_2、_3、_4 的邻接文件和预览。
- Phigros 候选显示 Addressables key、bundle、Texture2D object name、nameSource，并允许人工修正。
- 删除/替换先写 ReviewDecision，不直接删除 ROS 或 Legacy 文件。

### 资源管理

- 按 Resource、Variant、Rendition 浏览，也可按原始路径、hash、provenance 检索。
- 预览原图、AI、缩略图及尺寸/格式/大小。
- 修改 metadata 和关系，保留前后 diff。
- 查看同 hash 的 alias、同 songId 的其它 variant、同角色的其它 role。
- 手动补充资源必须有 sourceType=manual 和 provenance。
- 删除先做 Catalog tombstone 或 unreferenced candidate，真正 ROS GC 后做。

### 发布中心

1. dry-run manifest：新增、复用、修改、tombstone、上传对象和预计字节数。
2. validation：schema、引用完整性、object size/hash、缩略图、无秘密/本机路径、无 duplicate canonical ID。
3. 明确人工确认点，显示即将公开的对象和 Catalog diff。
4. ROS 上传后 HEAD、范围读取、metadata/hash 验证。
5. 生成可审阅的 Catalog diff，再 commit/push。
6. 显示 GitHub Pages workflow 状态。
7. 只有对象和 Catalog 都验证成功后，才允许清理指定 staging 批次。

## 3. 实际审核动作

| 情形 | 自动默认 | 管理员必须看到 |
|---|---|---|
| 原图/AI 同归一化文件名 | 同一 Variant 的两个 rendition 候选 | 预览、尺寸、hash、source path |
| _0 到 _4 文件 | difficulty variant 候选 | metadata difficulty、邻接 base、预览 |
| 同 hash 不同文件名 | alias candidate，不自动合并 | hash、目录、来源版本、分类 |
| 同 songId 多张图 | 多个 variant candidate | songId、variant key、文件名、预览 |
| Arcaea IDX 命中 metadata | 高置信补字段 | metadata source/version |
| Phigros key 可解析 | 中/高置信补字段 | Addressables key、bundle、nameSource |
| changed bundle | 暂存待人工 | old/new bundle、key diff、Texture2D 列表 |
| CG/剧情贴图不清 | 不自动合并 | APK path、story metadata、预览 |
| 删除/替换 | 只生成 PublishPlan | 引用计数、Catalog diff、替代对象 |

## 4. MVP 与后做

| 能力 | MVP | 后做 |
|---|---|---|
| 本地 Catalog 浏览/搜索 | 必须 | — |
| staging 候选审核、预览、字段编辑 | 必须 | 近似图、OCR |
| Resource/Variant/Rendition 编辑 | 必须 | 批量规则 |
| APK checker 和 previous baseline 状态 | 必须可见 | 全自动 scheduler 控制台 |
| Arcaea diff、Phigros 导出审核 | 必须 | 精确 changed-bundle 解析 |
| dry-run、validation、ROS 上传验证 | 必须 | 自动 GC、回滚 |
| GitHub Pages 状态 | 读取 workflow | 自动重试 |
| 访客统计、公网 Admin、账号系统 | 不做 | 不属于当前目标 |
| SSH/Nginx/VPS 发布 | 不做 | — |

## 5. 推荐闭环

    UpdateRun 或 Legacy scan
      → CandidateFile 预览和关系证据
      → 人工决定 Resource/Variant/Rendition
      → PublishPlan 和 validation
      → 手动确认
      → ROS 上传和验证
      → Catalog 生成/提交
      → Pages workflow
      → 只清理已验证 staging

Admin 后端只监听本机，不应成为 Catalog 的唯一事实来源，也不应复活旧 stats-server 的公网 runtime API。

