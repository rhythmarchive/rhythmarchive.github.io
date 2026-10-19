# 谱面资料与版本复核

Catalog 的 `metadata.charts` 是详情页和筛选的共同来源。继续使用现有详情区块、Gallery/Browse 筛选和 RangeHistogram，不建立第二套组件或浏览器端第三方查询。卡片投影只携带筛选需要的字段；物量、署名、来源留在详情页。

## 字段与更新规则

- `difficulty` 是谱面档位；`level` 是游戏显示等级；`constant` 是有来源的定数，显示一位小数。三者不能互相代替。Phigros 原始小数 `level` 来自原生定数，投影时分离显示等级和定数；Orzmic 原生 `difficulty` 是显示等级、`level` 是定数。
- `notes` 是来源声明的物量。Rizline 的击打数与 `combo` 最大连击分开；Dynamix 客户端 `CMap.combo` 记作最大连击，Wiki 物量与其不一致时不合并。
- `noter` 是谱师，Rotaeno 旧字段 `artist` 的谱师语义在投影中归并。`fieldSources` 保存逐字段来源，`sourceUrl` 提供可访问的社区资料链接；一个社区链接不代表所有字段都由社区提供。
- `metadata.chartDataVersion` 是**本次核对所针对的资源版本**，不是新增曲目的加入版本，也不是抓取日期。`chartDataUpdatedAt` 记录核对日期。`gameVersion` 等原有加入版本保留。
- 每次游戏更新都重新核对**已有谱面**和新增谱面；比较完整的定数值，不以等级未变、物量相同、网页刚抓取或网页最近修改为“定数未变”的证据。注意区服、平台、重制/Legacy/特殊谱面以及同名不同曲师。
- 优先采用目标版本客户端原生字段。社区来源需核对其适用版本、当前汇总表和改定数历史；旧页面不能优先于已更新的汇总表。无法证实现行、身份不唯一或来源冲突的定数留空，保留已确认的其他字段。不得从整数等级推导 `.0`，不得把未定级填成 0。
- 内容检查将 `chartDataVersion` 与既有 Browse manifest 的 `sourceVersion` 对齐；没有正式 Browse 的游戏采用 Updates 的最新版本（含 baseline）。升级版本后，旧标记会使 `content:check` / `check:fast` 失败。完成上述复核或移除未确认定数后才能推进标记，不能只改版本字符串消除失败。
- 定数变更写入 Catalog 后，详情、范围边界和直方图从同一快照生成。按现有流程刷新 Browse 的 Catalog 哈希绑定和公共投影；无需新增资源对象、ROS 上传或运行时请求。

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
