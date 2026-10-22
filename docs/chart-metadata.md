# 谱面资料与版本复核

Catalog 的 `metadata.charts` 是详情页和筛选的共同来源。继续使用现有详情区块、Gallery/Browse 筛选和 RangeHistogram，不建立第二套组件或浏览器端第三方查询。卡片投影只携带筛选需要的字段；物量、署名、来源留在详情页。

## 字段与更新规则

- `difficulty` 是谱面档位；`level` 是游戏显示等级；`constant` 是有来源的定数，显示一位小数。三者不能互相代替。Phigros 原始小数 `level` 来自原生定数，投影时分离显示等级和定数；Orzmic 原生 `difficulty` 是显示等级、`level` 是定数。
- Orzmic 的原生 `MusicDatas.Difficulties` 四个槽位依次为 EASY、NORMAL、HARD、SPECIAL；Catalog 的 `difficultyName` 保留档位名，公共投影以它作为 `difficulty`，原有显示等级和定数保持独立。空槽位不会使后续档位前移；未知槽位阻止提取，不猜名称。本次为 223 项曲绘的 665 张谱面补齐名称，等级、定数及物量均与保留的 3.17.0 原生快照逐行核对。
- `notes` 是来源声明的物量。Rizline 的击打数与 `combo` 最大连击分开；Dynamix 客户端 `CMap.combo` 记作最大连击，Wiki 物量与其不一致时不合并。
- `noter` 是谱师，Rotaeno 旧字段 `artist` 的谱师语义在投影中归并。`fieldSources` 保存逐字段来源，`sourceUrl` 提供可访问的社区资料链接；一个社区链接不代表所有字段都由社区提供。
- `metadata.chartDataVersion` 是**本次核对所针对的资源版本**，不是新增曲目的加入版本，也不是抓取日期。`chartDataUpdatedAt` 记录核对日期。`gameVersion` 等原有加入版本保留。
- 每次游戏更新都重新核对**已有谱面**和新增谱面；比较完整的定数值，不以等级未变、物量相同、网页刚抓取或网页最近修改为“定数未变”的证据。注意区服、平台、重制/Legacy/特殊谱面以及同名不同曲师。
- 优先采用目标版本客户端原生字段。社区来源需核对其适用版本、当前汇总表和改定数历史；旧页面不能优先于已更新的汇总表。无法证实现行、身份不唯一或来源冲突的定数留空，保留已确认的其他字段。存在精确定数的游戏不得用等级填补缺值，不得把未定级填成 0。经原生数据确认仅有整数等级的 Dynamix 使用等级数值生成“谱面定数”柱状图，按 `.0` 显示；这是筛选规则，不向 Catalog 写入虚构精确定数。
- 内容检查将 `chartDataVersion` 与既有 Browse manifest 的 `sourceVersion` 对齐；没有正式 Browse 的游戏采用 Updates 的最新版本（含 baseline）。升级版本后，旧标记会使 `content:check` / `check:fast` 失败。完成上述复核或移除未确认定数后才能推进标记，不能只改版本字符串消除失败。
- 定数变更写入 Catalog 后，详情、范围边界和直方图从同一快照生成。按现有流程刷新 Browse 的 Catalog 哈希绑定和公共投影；无需新增资源对象、ROS 上传或运行时请求。

## 2026-10-22 In Falsus 本地版本复核

本批采用 Steam build `26126718`（Depot manifest `2074612446327118683`）的原生 `SongData.ChartInfos.Rating`，新增 Disruptor Array、空間創造理論、Megameteor、TECHNOPOLIS 2085、Yume no hajimari 五首曲目的曲绘与 20 张谱面资料。逐一核对已有 297 张公开可用谱面的完整定数，均未变化；原有公开可用性保持不变。当前客户端 320 张可用谱面的原生 Rating 均为整数，公开曲库中的 317 张可用谱面采用已核实的原生定数。谱师仅采用客户端已解析的实际署名，未解析的映射键与未知物量不补写。

`chartDataVersion` 更新为 `Steam build 26126718`，已有资源的加入版本保持原值。原生 SongData 快照和完整歌曲语义清单留在私有 Workspace，供后续版本重新核对；公开字段记录本次原生定数来源。

## 2026-10-21 定数类型复核

“游戏实际使用小数数值”和“官方公开了完整定数表”是两个判断。客户端原生字段可证明小数值存在；社区表中的逆算值不是官方发布的表。不能把资料缺失判断为游戏没有小数定数。

| 游戏 | 已核对的依据 | 筛选规则 |
| --- | --- | --- |
| Arcaea | 当前高、低等级定数表及漏项单曲页；低等级表虽然页头仍标 6.16.0，但已含 DREAD AREA、un、Riven Pilgrimage 等 7.0 曲目，不能整表弃用。定数与 APK 的 `rating` / `ratingPlus` 显示等级不同。 | 保留真实一位小数，PST/PRS 同样参与。 |
| Phigros | 4.0.1 原生 `GameInformation.SongBase.difficultyRaw`，1,042 个正值中 817 个带小数。 | 保留原生定数。 |
| Rizline | 当前官方资源版本 `v144_2_7_1_346654b724P` 的 `Default.charts[].difficulty`，444 个值中 256 个带小数；原生值包括 13.4 等，不只是 `+` 转换。 | 保留原生定数。 |
| Rotaeno | 原生 `StandardChartDataSO.v2InnerDifficulty`。本次重读已有 APK 提取的 242 个值，其中 122 个带小数；这是对原生数值类型的复核，不以旧快照覆盖当前 2.27.0 数值。 | 保留已核实的精确定数。 |
| Orzmic | 3.17.0 `assets/gamedatas` 的 `MusicDatas.Difficulties[].Rating`，623 个正值中 375 个带小数。原生 `Difficulty` 是显示等级。 | 保留原生定数。 |
| Paradigm: Reboot | [全曲表维护者](https://wikiwiki.jp/paradigm_/全曲ソート表)明确区分 `.0` / `.5` 与高等级的 `.0`–`.9`；Rating [研究与计算实现](https://github.com/PRProber/paradigm-reboot-prober-backend#数据来源及计算方式参考)使用这些数值。这是社区测算依据，本次未获得官方公开的完整定数表或原生逐谱定数导出。 | 保留带来源的小数定数，不按整数替代；不宣称维护表由官方发布。 |
| In Falsus | Steam build 25594228 原生 `ChartInfos.Rating` 的保留提取中，300 张可用谱面均为整数 1–15。提取器保留原始数值，不做取整；`LevelSectionIndicator` 另存为显示等级。 | 当前原生整数 Rating 显示为 `.0`；不声称未来版本永远没有小数。 |
| Dynamix | 3.20.01 / CDN 03200101 官方 `_songlist` 的 1,818 个正等级均为整数；保留的原生类型证据声明 `CSongList.MapData.level` 为 `int`。未发现另一个可核实的小数定数字段。 | 恢复整数柱状图，`13` 按 `13.0` 筛选和显示，不新增等级下拉框。 |

Arcaea 本次补入 1,049 个 Resource 谱面定数，562 项曲绘元数据受影响；源曲目清单按歌曲去重后，1,834 张常规谱面的精确定数全部具有明确来源。高等级表已有值与本次完整匹配结果没有差异。低等级表缺少的 `undefined` PST/PRS、`~_+` PST，以及 Château de cartes PRS/FTR/ETR 使用各自单曲页明确值；un PRS 的 7.8 由汇总表和单曲页交叉确认，保留原有显示等级字段。

[Château de cartes 的中文单曲页](https://wiki.arcaea.cn/Ch%C3%A2teau_de_cartes)明确列出 PST/PRS/FTR/ETR 为 4.5/7.8/9.4/10.3。日文页仍将 PST 标为“未判明”，因此最后一项采用中文页的 4.5，并逐字段保存该来源；不是由等级 4 推导成 4.0。

本次读取高等级表 HTML 的 SHA-256 为 `3d25a5e4eb4bcb295a4baa9c841c8e58395fe2b7526a9a6ef8cfca52b1039078`，低等级表为 `addd80ce7793477fc4a2028fbc26e767f510252b14bb71d8d0c9c04ee3b56b25`。来源链接保存在各谱面的 `fieldSources.constant`；下载副本为可清理的任务临时数据。

## 2026-10-19 采用来源

下面的版本是复核目标。社区资料是可变快照，不构成游戏官方对全部定数的保证。

| 游戏 | 目标版本 | 定数与补充字段依据 |
| --- | --- | --- |
| Arcaea | 7.0.260c | 当前 [高等级定数表](https://wikiwiki.jp/arcaea/譜面定数表)（收录批次标为 7.0.0）与 [7.x 更新记录](https://wikiwiki.jp/arcaea/アップデート履歴/v7.0.0～)核对；谱师优先目标 APK 的 songlist，物量来自 [物量表](https://wikiwiki.jp/arcaea/ノーツ数順)。高等级表是社区现行表，并非补丁逐谱重测。低等级表仍标 6.16.0，本批不采用其定数。 |
| Phigros | 4.0.1 | 同版 APK 的 GameInformation 定数/谱师和实际谱面 JSON。1,042 张有效谱面已计数；不采用旧 gameinfo combo 缓存。明鏡烈火 HD 实际 JSON 计数 566，不能按其旧声明 564 覆盖。 |
| Rizline | v144_2_7_1_346654b724P（2.7.1） | 当前官方资源 Default.charts 的原生 difficulty/designer，覆盖全部 444 张常规谱面；击打数/最大连击来自 [Wiki](https://wikiwiki.jp/rizline/)各单曲页，来源逐行保存。包括 Wiki 缺定数的 Authentic 三档，定数采用原生值。 |
| Rotaeno | 2.27.0 | 当前 APK 的原生 chart manifest（58 首、242 谱）与明确标注 2.27.0 的 [定数表](https://wikiwiki.jp/rotaeno/譜面定数表)交叉核对；谱师优先同版原生覆盖字段，其余来自 [谱师表](https://wikiwiki.jp/rotaeno/譜面製作者一覧)。旧 2.26 来源中未被当前证据确认的值撤下。两份当前来源相互冲突时也不采纳定数。 |
| Paradigm: Reboot | 4.12（D166） | Wiki 链出的 [维护资料表](https://docs.google.com/spreadsheets/d/17cZ63khqX81K0bQ98qSJpwWH_0aTgy5hzjrvp-CRemM/edit)，已包含 4.11/4.12 曲目；不把仍标 4.9 的 Wiki 全曲页当作最新快照。沿用已审核的 songId/Wiki 名称映射，同名曲再按曲师区分。Indelible Scar MSV 的 Catalog 等级 16+ 与日文资料等级 16 不同，定数暂留空。 |
| In Falsus | VSingers DLC（v1.0.5 / Steam build 25594228） | [中文维基曲目列表](https://infalsuswiki.org/wiki/曲目列表)及单曲页明确的定数/署名/物量。物量基于该 build 的游戏判定代码，来源未声称逐谱实机对账；原有 297 张有效公开谱面保持身份和可用性。 |
| Orzmic | 3.17.0 | 同版 APK MusicDatas 的 623 个正定数。未能证明适用当前版的 8 个社区补值不采用，未定级特殊谱面保持空值。 |
| Dynamix | 3.20.01 / CDN 03200101 | 当前 `_songlist` 对应谱面等级和 CMap.combo；[Wiki](https://w.atwiki.jp/dynamix2ch/)补物量与谱师。没有可靠小数定数，范围控件明确筛“难度等级”。 |

Rotaeno 对比发现的旧值修正包括 Beat Rise IV 12.8→12.9、Elyqiria III 10.4→10.5、LINK x LIN#S IV 12.7→12.9 等。悔_ I／II／III、Snapdragon IV、Uchronia III、Neural Rewind Protocol III 存在原生值/社区表或等级冲突，保留等级，定数留空。不得将“只补空值”当作以后版本更新的处理方式。

### 曲绘对应范围

Arcaea、Phigros 和 Paradigm 沿用已有独立曲绘关联：共享图排除由独立图拥有的档位，切图同步谱面区块。Rotaeno 本批补查原生 `StandardChartDataSO.overrideResources._coverHdRef`，无覆盖时回落 `SongDataSO.resources._coverHdRef`：

- Centimental：`71982ff4-5564-7e7d-b820-fc0e1521c896` 对应 I／II／III，`da2dc38b-ff66-71cc-9992-c2ffbf54affd` 对应 IV。前者文件名虽然带 IV，原生引用却相反；不能按图片文件名推断档位。依据 `side_261map` bundle（SHA-256 `943b047c9da52da13f9451debeaff2ba715ba79ac6feb355f002b59518f7a021`），Song path ID `6638661777455848737`。
- Quadruplicity：四档均使用 `602048e0-917b-7754-9b38-5d058fa8dfa1`；fake 图 `67a818a8-6135-76f7-9541-ddab39e1e988` 未找到谱面引用，保留图片、清空谱面关联。依据 `side_sc1mapview` bundle（SHA-256 `9329dc50c7bc5189c8ca126c3c0fea6ce49c210f5371c2d235410634b845bc78`），Song path ID `6208461640678116070`。
- めんどくさいモード、Re：End of a Dream、Rush E 的 9 张图片尚无已核实的原生档位绑定。本批保留图片，以 `chartArtworkStatus: unresolved` 记录，暂不显示或匹配整首歌的谱面。后续拿到明确引用后再恢复对应行，不能按名称、图片序号或猜测补齐。

### 可复核的快照指纹

这些指纹用于区分本批实际读取的数据与后来变化的上游页面，不需要在公共仓库保留下载副本：

| 来源 | SHA-256 |
| --- | --- |
| Arcaea 7.0.260c APK | `2ccc879de95932d47ff62fc1bc18acbbeb43f43671302e4240498005f6e2b9e2` |
| Arcaea 高等级表 HTML | `2b8040f7fe55d9f91a11d3f3e46ee34b0173370978ea5ac4a02b07b1e71c520c` |
| Phigros 4.0.1 APK | `f59a041f5bc02d0f3eb51a67739ec0271590ac412e68cf6cc6b43621cdf08985` |
| Rizline 当前 Default 资源 bundle | `e16b6c751c354e18fe319c8b6bd6f9e016a0e8d05111be7adf383a5d4ad7811c` |
| Rotaeno 2.27.0 定数表 HTML | `fbcdb225120f54a037f6a576cd090c57e98fb7f8c030ad83c4daed7f1c3d4891` |
| Rotaeno 2.27.0 原生 chart manifest | `415691bebebfaa7de1c8be5f4b51f2a34f46b9a272acefe1346c878044a9a28d` |
| Rotaeno 2.27.0 APK | `93b0916854b246b90b36d65529019d30d801b25dc87e5e7917b8f9d9dbf63fc5` |
| Paradigm 资料表 XLSX | `130621cd824b111f61038a341766ecf9785c97936a8101403378f63f76bbe050` |

缺失项仍以 `—` 显示；启用定数范围时，没有已确认定数的谱面不会命中。无筛选时仍可浏览这些曲绘和已知谱面资料。
