# Phase 5 最终验收

验收日期：2026-08-15。Phase 5 已完成针对真实 Catalog、静态产物和本地浏览器的最终审计；未修改正式 Catalog、ROS、APK 或 migration 状态。

## 站点与部署

- 站点：`apps/site`，Astro + TypeScript，static output。
- 生产 origin：`https://rhythmarchive.github.io/`。
- 生产 base：`/`。
- 默认环境：`PUBLIC_SITE_ORIGIN=https://rhythmarchive.github.io`、`PUBLIC_BASE_PATH=/`、`PUBLIC_ROS_BASE_URL=https://rhythm-assets.cn-nb1.rains3.com`。
- Pages workflow：`.github/workflows/pages.yml`，目标为 `rhythmarchive/rhythmarchive.github.io`，只执行依赖安装、`site:build`、artifact upload 和标准 Pages deployment action；不运行 migration、ROS upload、APK extractor、Admin 或 secret-dependent command。
- `git remote -v` 当前无输出，remote 未配置；本次未修改 remote、未 commit、未 push、未 deploy。

## Catalog 统计

正式 `catalog/index.json`：

| 指标 | 数量 |
|---|---:|
| Resource total | 2,468 |
| Arcaea | 1,967 |
| Phigros | 501 |
| multi-Variant Resource | 0 |
| 有 upscaled 的 Resource | 603 |
| original Rendition | 2,468 |
| upscaled Rendition | 603 |
| preview 320 / 640 / 1280 | 各 2,468 |

分类数量：

| 游戏 | 分类 | 数量 |
|---|---|---:|
| Arcaea | 曲绘 | 603 |
| Arcaea | 剧情 CG | 57 |
| Arcaea | 剧情贴图 | 296 |
| Arcaea | LinkPlay | 148 |
| Arcaea | 头像 | 130 |
| Arcaea | 角色立绘 | 139 |
| Arcaea | 游玩背景 | 274 |
| Arcaea | 贴纸 | 99 |
| Arcaea | 世界模式 | 17 |
| Arcaea | 曲包封面 | 195 |
| Arcaea | 启动页面 | 9 |
| Phigros | 曲包封面 | 41 |
| Phigros | 曲绘 | 320 |
| Phigros | 头像 | 107 |
| Phigros | April Fools | 33 |

upscaled 违规统计为 0：全部 603 个均为 `Arcaea / jacket`；Arcaea 非曲绘和 Phigros 均无 AI upscaled。

## 路由与公开投影

- `/`、`/arcaea/`、`/phigros/`、`/search/`、`/404.html` 均存在。
- 实际 category route：15 个。
- Resource detail HTML：2,468 个。
- missing detail route：0；duplicate route：0。
- sitemap URL：2,487 个（不含 `404.html`）。
- 浏览器数据来自 build-time public projection 和精简 gallery/search JSON，不复制完整内部 Catalog。
- `dist`、generated public JSON、built HTML/JS/CSS 和 public JSON 共扫描 2,531 个文本文件；Windows path、`.runtime`、ReviewLog、workspace path、ROS credentials、migration provenance、内部 Object metadata 命中：0。

Search index：

- entries：2,468
- `search-index.json`：598,403 bytes
- 支持 title exact > prefix > substring > artist > other metadata；无拼音搜索。
- 浏览器实测：`光速神授説`、`Divine Light`、`theraft`、`[PRAW]` 均返回正确结果；空 query 不返回全站；不存在的 query 显示“没有找到相关资源。”

## 功能验收

- Gallery 初始 48 项，点击后 96 项；筛选后重新从 48 分页。FTR 筛选 URL 为 `?difficulty=FTR`，刷新后状态保持。无意义分类不显示筛选器，Phigros 不显示 AI 筛选或 AI badge。
- Gallery 静态产物 17 页，初始 card 数量范围为 9–48；full image `<img>` 和 full preload/prefetch 命中均为 0。
- Gallery 普通图片只使用 320/640 preview；Detail 使用 1280，回退 640/320。Arcaea AI、Arcaea 非曲绘、Phigros 三类详情均实测未点击下载时 full Object request count = 0。
- Arcaea jacket AI detail 实测原图按钮请求 original，AI 超分按钮请求 upscaled；文件名均来自 Catalog `downloadFilename`，不是 Object key。AI 按钮只在真实存在 upscaled 时出现。
- 将一次原图请求模拟为 500 后，页面显示“下载失败，请重试”，并实际打开 direct ROS URL fallback。
- Gallery 实测混合选择 AI + 非 AI：优先 AI 时有 upscaled 用 upscaled、无 upscaled 用 original，不因单项缺少 AI 而失败。
- Batch ZIP 实测生成 2-entry ZIP；JPEG/WebP 使用 STORE，测试 entry 的 `Length == CompressedLength`。重复命名测试覆盖 `name.jpg`、`name (2).jpg`、`name (3).jpg` 等安全规则。
- 使用浏览器 mock 响应进行 4 项 batch 测试，并发峰值为 3；选择 31 项时实际显示“一次选择的文件较多，请减少后再下载。”且 full request 为 0。保护值为 `MAX_BATCH_FILES=30`、`MAX_BATCH_BYTES=300 MiB`。
- 正式 Catalog 没有 multi-Variant Resource，因此没有可用的真实多版本页面可点击切换；代码仍只在真实多 Variant 时渲染 selector。3 个 unresolved 版本现在显示“其他版本”，不显示 difficulty 或内部 warning。
- `apps/site/data/apk-downloads.json` 不存在；首页完全隐藏 APK card，也不显示未配置提示。
- Theme 实测 System / Light / Dark 三态，手动选择写入 localStorage，刷新后保持；默认 System，按钮 aria-label 为“切换主题”。
- Logo 为原创 RA 几何 mark + Rhythm Archive wordmark，蓝色主 accent 和青色节奏线；favicon 使用同一原创 mark。

## 浏览器视觉验收

使用本地 Playwright 检查了首页、Arcaea/Phigros game page、Arcaea jacket gallery、Arcaea 非曲绘 gallery、Phigros gallery、Search、AI detail、非 AI detail、Phigros detail 和 unresolved detail。

- viewport：1440×900、768×900、390×844。
- 首页品牌、Header、图片型游戏入口、Gallery contain、长标题截断、移动端 2 列、Detail 移动单列、下载按钮、Filter 收纳和 Dark/Light 对比均正常。
- 无横向溢出；首页标题约 32px，未形成超大 Hero 或大片无意义留白。
- 截图保存在 `.runtime/site-audit/`，未纳入提交：`home-desktop.png`、`home-mobile.png`、`arcaea-mobile.png`、`detail-ai-desktop.png`、`detail-ai-mobile.png`。

本次 targeted fix：

1. 用 `site.webmanifest.ts` 统一走 URL helper，修复 manifest 在非 `/` base 下的 `start_url`、scope 和 icon 路径。
2. 删除首页技术化的 “Catalog” 文案，保持用户语言。
3. 修正 unresolved/default 版本标签顺序，确保 unresolved 不会显示为“默认”或难度，并补充测试。
4. Detail preview 补充资源标题 alt；装饰性 RA mark 保持空 alt。

## 产物与命令证据

最终 `apps/site/dist`：

- total bytes：52,835,877
- file count：2,518
- HTML：2,489
- JSON：20
- JS bytes：19,385
- CSS bytes：28,148
- search index：849,512 bytes
- smoke ordinary image count：20,489；未发现普通 `<img>` 指向 original/upscaled full Object。

最终命令结果：

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | exit 0 |
| `npm test` | exit 0；62 passed，0 failed，0 skipped，0 todo |
| `npm run site:check` | exit 0；44 files，0 errors，0 warnings，0 hints |
| `npm run site:build` | exit 0；2,489 page(s) built；无 Astro/build warning |
| `npm run site:smoke` | exit 0；`status: PASS` |

SEO 已检查首页、两个 Game 页面、Search 和 AI Resource：title、canonical、OpenGraph、robots、sitemap 均生成；Resource OG image 只使用 preview，不使用 original/upscaled。默认 base `/` 已检查，并以 `/archive/` 做过 base helper 回归，manifest、内部链接、robots、sitemap 均正确带 base，无重复 `//`。

## 结论

Public V2 已通过最终本地验收，可进入首次 GitHub Pages 部署。

当前没有代码、构建或本地验收 blocker。唯一的数据限制是正式 Catalog 当前 `multi-Variant Resource=0`，因此无法用真实生产数据演示多 Variant 点击切换；这不是前端失败，也没有修改正式 Catalog。

## Phase 5.5 Product Rework

1. Arcaea public display 使用 `apps/site/src/lib/public-display.ts` 的 deterministic normalizer，按现有 extractor 文件 schema 分离真实曲名、artist、version、BPM、Side；不改 Resource/Variant/Rendition、Catalog 或 ROS Object。全部 1,967 个 Arcaea public title 均不再含 `_IDX`、`_BPM`、`_SIDE` 或图片扩展名。603 个 Arcaea jacket 中仍有 11 个无法可靠补出 artist/结构化提取字段，保持已有标题且不猜测。
2. 首页改为 Rhythm Archive 的蓝白、青色 accent、斜线和几何切割视觉；游戏入口不再使用随机曲绘，当前本地没有合适的游戏官方图标，因此使用设计化 A/P 文字 fallback，并保留后续替换入口。分类已按 Arcaea / Phigros 分行。
3. Gallery 使用按 game + resourceType 的 media ratio：Arcaea jacket/头像为方形，Phigros jacket、剧情 CG、背景和横向素材为 wide，角色立绘为 portrait；Gallery `cover`，Detail 保持完整比例展示。
4. 全站超分文案统一为“含超分版”；非 upscaled Resource 不显示该 badge。
5. Detail 改为 Media + Resource Info；原图和超分版同级、同尺寸、同基础颜色，下载区归入右侧信息栏，超分版只保留轻量“推荐”。
6. Search 增加居中的 landing、真实游戏/分类快捷入口；有 query 时复用普通 Gallery Card，并保留原始来源字段仅作为搜索 keyword，不再作为标题展示。
7. Bilibili 入口位于 Footer 和 Feedback 页面：<https://space.bilibili.com/385607044>。
8. 新增 `/feedback/`。giscus 正式配置集中在 site config，使用 GitHub Discussions 分类“问题反馈 & 提出建议”；脚本加载失败才显示 Discussions fallback。System / Light / Dark 会分别同步为 `preferred_color_scheme` / `light` / `dark`，主题切换通过 iframe postMessage 即时更新。
9. Brand mark / wordmark 已重做为自有 Rhythm Archive 蓝青几何版本，借鉴轻量 BA-inspired 排版与线条感，没有引入官方 Logo、角色或 UI 素材。
10. 最终验证：`npm run typecheck`、`npm test`（62 passed）、`npm run site:check`（44 files，0 errors/warnings/hints）、`npm run site:build`（2,489 pages）、`npm run site:smoke`（PASS；2,468 resources / 2,468 search entries）。
11. 浏览器截图保存在 `.runtime/site-polish/`，未纳入提交；关键文件包括 `home-desktop-final.png`、`home-mobile-final.png`、`arcaea-gallery-desktop-final.png`、`phigros-gallery-desktop-final.png`、`detail-ai-desktop-final.png`、`detail-ai-mobile-final.png`、`search-empty-desktop-final.png`、`search-results-desktop-final.png`、`feedback-desktop-final.png`、`feedback-mobile-final.png`、`feedback-dark-synced-final.png`、`feedback-system-final.png`。
12. 当前没有代码、构建或关键页面验收 blocker；剩余的 11 个 Arcaea 不可可靠补 metadata 项和游戏图标 fallback 都是明确的数据/素材限制，不涉及本轮架构或迁移。
13. Phase 5.5 Product Rework 完成，可重新部署线上站。
