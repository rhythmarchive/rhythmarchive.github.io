# 流量改造验收记录（2026-09-23）

## 同口径浏览器首开

Playwright CLI 默认桌面视口、全新浏览器 session，打开 Arcaea jacket 并等待图库 JSON 与图片请求。旧版来自当时正式 `https://rhythmarchive.github.io/arcaea/jacket/`，新版来自本地静态构建 `http://127.0.0.1:8765/arcaea/jacket/`。请求列表保存在忽略的 `temp/baseline-requests.txt`、`temp/local-requests.txt`；图片字节为**这些已请求对象**逐个 HEAD 得到的 `Content-Length` 之和，代表冷缓存完整响应体，不含 HTTP/TLS 开销。两次环境的 Stats API 请求不同，总请求数只作参考。

| 指标 | 旧版正式站 | 新版本地构建 |
| --- | ---: | ---: |
| 全部请求 | 62 | 60 |
| ROS 图片请求 | 48，均为 JPG original | 48，均为 WebP preview |
| 图片响应体字节 | 11,289,641 B | 935,748 B |
| 图片响应体降幅 |  | 91.7% |

浏览器对 `Sayonara` 筛选得到 1 项，当前图片为 small WebP；选中后托盘缩略图仍为同一 WebP。点击单项批量下载才请求 `/data/batch/arcaea/jacket.json` 和 JPG original，ZIP 下载成功。初始 48 张卡片中最多 6 张显式 eager；真实浏览器会因原生 lazy 阈值提前请求可视区附近的图片，故图片请求数仍为 48。

## 静态数据与缓存

以下是同一仓库构建前后文件大小，gzip 为 Node `gzipSync` 测量。GitHub Pages 对旧版线上 JSON 的实测响应 `Content-Encoding: gzip`、`Content-Length: 311,572`、`Cache-Control: max-age=600`；它与本地旧构建的 gzip 字节数不同，不能混作同一次实验。

| 文件 | 旧 raw / gzip | 新 raw / gzip |
| --- | ---: | ---: |
| Arcaea browse jacket JSON | 2,197,585 / 299,534 B | 1,165,510 / 179,797 B |
| Arcaea generic jacket JSON | 2,315,980 / 248,342 B | 602,057 / 91,577 B |
| Paradigm/Reboot generic jacket JSON | 1,689,957 / 199,052 B | 537,980 / 90,593 B |

公开生成器重建 `apps/site/public/data`，去掉历史残留的完整 JSON 与无人使用的 `resources.json`；浏览 projection 保留筛选、排序、统计、选择所需字段，下载元数据按分类拆到仅点击下载才请求的 batch JSON。`npm run traffic:check` 在实际 `dist` 检查原图 URL、字段、文件预算与首批/eager 上界。预算根据本次实测留有增长空间。

雨云 ROS 采样：`/objects/0e453.../webp` 18,842 B、`/objects/85d2.../webp` 53,650 B、`/objects/f52e.../jpg` 241,492 B、Paradigm 原 PNG 405,669 B，均返回正确 `Content-Type`、`Content-Length`、ETag、Last-Modified、`Accept-Ranges: bytes` 和 `Cache-Control: public, max-age=31536000, immutable`；WebP Range 请求 `bytes=0-15` 返回 206 与正确 `Content-Range`。可变的 `/apk/arcaea/latest.json` 返回 JSON MIME、1,413 B、ETag/Last-Modified、`Cache-Control: public, max-age=300`。这些与 `packages/domain/src/storage.ts` 的内容寻址对象默认缓存、`packages/domain/src/arcaea-apk.ts` 的 latest 例外一致。本轮不改已正确的上传策略，也不重写旧对象。

Pages 的 HTML/JSON/JS/CSS 缓存由 GitHub Pages/Fastly 控制，旧版样本均是 `max-age=600`；CSS gzip 15,987 B，BrowseGallery JS gzip 7,381 B。ROS 带宽计费、CDN 命中与跨地域传输由雨云/网络基础设施决定，站点仓库不能直接测得或保证。本记录的图片数字是请求响应体大小，不等于雨云账单统计。
