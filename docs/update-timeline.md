# 更新记录维护指南

这份指南是图片资源更新流程的一部分。时间线只记录已经公开、可在站点查看的资源批次；它不是 Catalog、ROS 或发布状态的替代品。

## 唯一来源

正式时间线数据位于 catalog/updates/index.json。网站构建通过 apps/site/src/lib/update-history.ts 读取它，再关联当前公开 Catalog 资源生成时间线投影。

不要编辑以下生成物来修复时间线：

- apps/site/src/generated/
- apps/site/public/data/
- apps/site/dist/
- temp/

如果源资源、Catalog 或发布记录发生变化，应修正正式源数据和 catalog/updates/index.json，再重新生成公共数据。

## 什么时候追加记录

完成现有更新流程后，只有在以下条件都满足时才追加时间线记录：

1. 资源已经通过 review/approval。
2. 对应发布已正式完成，资源在当前 Catalog 中为公开状态。
3. 站点能够从当前公共投影找到这些 resourceId。
4. publishedAt 是本站资源实际公开时间，带时区且稳定。

READY_LOCAL_ONLY、草稿、候选包、未完成的 ROS/发布流程都不能进入时间线。

## baseline 规则

每个游戏首次整体公开收录的批次写入 baselines，不写入 records。baseline 用来明确说明“从哪一批开始计时”，不能通过隐藏排序后的第一条记录来猜测。

后续正式批次才写入 records。如果某游戏只有首次整体收录，时间线中不应出现该游戏。

当前范式：起源只有首批 baseline，因此没有时间线记录。以后如果该游戏出现新的、独立且正式公开的图片资源批次，再按普通 update record 追加。

## 数据结构

catalog/updates/index.json 的结构如下：

~~~json
{
  "schemaVersion": 1,
  "baselines": [
    {
      "id": "stable-batch-id",
      "game": "arcaea",
      "releaseIds": ["release-manifest-id"],
      "publishedAt": "2026-08-14T13:57:23.1Z",
      "contentVersion": "6.16.0"
    }
  ],
  "records": [
    {
      "id": "stable-update-id",
      "game": "arcaea",
      "releaseIds": ["release-manifest-id"],
      "kind": "update",
      "publishedAt": "2026-09-02T05:52:52.235Z",
      "contentVersion": "7.0.255c",
      "items": [
        { "resourceId": "catalog-resource-id", "change": "added" }
      ]
    }
  ]
}
~~~

约束：

- id 必须稳定且唯一；重跑同一批次不能生成新 ID。
- 同一逻辑批次关联多个 ReleaseManifest 时，合并到一个 record 的 releaseIds，不要生成重复时间线卡片。
- items 中同一 resourceId 只出现一次。
- change 只用于内部合并优先级：added、supplemented、replaced。这是数据处理字段，不能作为用户界面的分类文案。
- 页面统一显示“更新 N 项”；分类筛选使用当前公共资源的游戏类型和分类标签。
- contentVersion 只有在来源明确时才填写，不把它宣传为官方最新版本。
- publishedAt 不能使用构建时间、文件 mtime 或资源当前 updatedAt 代替。

## 哪些变化不应生成记录

以下内容不单独生成时间线批次：

- 只有标题、排序、内部元数据变化。
- 只重建缩略图、转换格式或迁移存储位置。
- 同一内容重复上传。
- UNCHANGED。
- 来源中消失的资源；REMOVED 仍按现有 review/storage 规则处理，不在页面制造删除动态。
- 未批准或尚未公开的资源。

同一批次中如果一个资源有多条内部变化，只保留一个 resourceId，由投影统计为一个更新项。

## 推荐操作顺序

1. 按现有 game-update/content-addition、review 和 release-publishing 流程完成资源更新。
2. 以当前 Git HEAD Catalog 和正式发布结果确认资源身份。
3. 确认这是 baseline 还是后续 update。
4. 在 catalog/updates/index.json 中显式追加或修正记录。
5. 运行公共数据生成和站点验证。
6. 检查 /updates/、对应批次详情、首页“最近更新”和游戏/类型筛选。
7. 显式暂存时间线源数据及代码变更，保留其他工作区修改；不自动 push、部署或删除远端对象。

## 验证

最少运行：

~~~text
npm run test:all
npm run site:check
npm run site:build
npm run site:smoke
git diff --check
~~~

检查结果还应确认：

- baseline 没有出现在公开时间线。
- 首页最近更新与 /updates/ 使用相同批次顺序和数量。
- 资源后来隐藏时不会泄露标题、图片、下载链接或内部路径。
- 详情页数量、预览和筛选结果与公共资源一致。
- 记录重跑后 ID、时间和资源项保持稳定。

npm run browse:check 只有在 package.json 提供该脚本时才执行；不存在时记录为未配置，不把它当成已通过。
