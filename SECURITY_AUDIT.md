# Rhythm Archive 安全审计

审计日期：2026-10-02 至 2026-10-03（Asia/Shanghai）。源码基线：`3d47e86`，开始时工作区无已跟踪修改或未跟踪文件；本次只修改更新页的 HTML 属性转义并新增本报告。

## 结论

**本次没有发现已证实的高风险漏洞，也没有找到匿名攻击者可直接利用的 XSS、管理员权限绕过、任意 SQL、任意文件读取、开放代理或凭据泄露。** 这不是对所有云端配置和所有未来输入的安全保证。

当前最值得处理的是两个中风险问题：匿名统计可被人为制造，以及原生限流绑定使源码中较严格的事件/提醒阈值不生效。它们主要影响统计可信度、D1 消耗和服务费用，不能据此接管网站或读取其他访客记录。

公开 Catalog 与页面隐藏规则之间也需要明确约定：隐藏资源不是私密资源。没有证据表明本次发现了私人文件，但不能把页面隐藏、UUID 或对象哈希当作访问控制。

| 分类 | 结果 | 处理状态 |
| --- | --- | --- |
| 已证实高风险 | 未发现 | 不把工具的 high 公告直接当作本站高危漏洞 |
| 中风险 M1 | 可自选匿名访客 ID，统计可人为制造 | 建议；未改线上写入规则 |
| 中风险 M2 | 原生绑定绕过较严格的按接口限流阈值 | 建议；未改 Cloudflare 配置 |
| 条件风险 C1 | 隐藏资源的元数据/对象键仍在公开 Catalog 中 | 公共信息边界已确认；隐藏对象 GET 权限未测试 |
| 条件风险 C2 | Turnstile 只核验 success，缺少 hostname/action 校验；Secret 缺失时不要求验证码 | 已本地验证条件；生产 widget/Secret 配置待核对 |
| 一般加固 H1 | 更新页字符串 HTML 中链接属性未统一转义 | 已本地修复；未部署 |
| 一般加固 H2 | 构建/开发依赖存在已知公告 | 已评估调用条件；未升级依赖 |
| 一般加固 H3–H6 | 响应策略、第三方脚本、隐私说明、CI/秘密防误提交 | 建议，优先级见后文 |

## 范围、方法与证据限制

检查了 Astro 静态页面及浏览器脚本、Catalog/schema/公共投影、下载与 ZIP 链路、Stats Worker 的全部路由与 SQL、D1 迁移和清理逻辑、APK 自动更新器、三个 npm 锁文件、三个 Actions workflow、忽略规则、Git 本地配置和可达历史、静态构建产物。

仅对本站发出 13 次低影响只读请求尝试：GET、HEAD、OPTIONS；其中备用 workers.dev 的一次请求因 DNS `EAI_AGAIN` 未完成。没有发送线上统计事件或提醒，没有执行管理写入、PUT/DELETE、隐藏对象下载、压力测试、限流探测或访客数据查询。滥用验证使用本地内存适配器和虚构输入。

GitHub/Cloudflare/Rainyun 控制台的当前权限、Secret 存在性、Token 范围、分支保护、账单限额和存储 ACL **没有在本次获得实时配置证据**。源码配置描述预期状态，不能证明控制台完全一致。读取了 Admin 的 Cloudflare inventory 以识别资源边界，其中有历史及互相更新的记录；没有把旧记录当成本次已确认的线上状态。GitHub 连接器的仓库元数据调用未成功取得结果。

没有进行浏览器端完整攻击回归；XSS 结论来自输入到输出的源码追踪、构建检查和更新页字符串渲染的本地 VM 验证。历史扫描按下述规则寻找秘密，无法识别所有无特征的随机 Token，也不覆盖远端未取回的 ref、不可达对象、Actions 日志/历史 artifact、外部 Release 文件或主机上的全部私有文件。

### 验证结果

| 检查 | 状态 | 证据 |
| --- | --- | --- |
| `npm run ci:check`，完整门禁一次 | VALID / 通过 | 站点测试 119/119，Worker 测试 29/29；类型检查、内容/投影/registry、Astro 检查、构建、traffic、smoke 通过；Astro 0 errors / 0 warnings |
| 静态构建审查 | VALID / 通过 | 4765 文件，159055272 字节；4034 HTML 页面、3977 资源详情页；检查 4136 个文本产物，未命中凭据特征/本机用户路径，无 `.map`、`.env`、`.dev.vars`、Git 配置、私钥、日志或原始 Catalog 文件 |
| 当前文件与 Git 历史特征扫描 | VALID / 完成，有低风险历史信息 | 789 个已跟踪文件，136 个可达提交，3666 个可达对象、2143 个唯一 blob，解码约 1.52 GB；匹配 GitHub/AWS/JWT/私钥/带凭据 URL/主要 Secret 赋值及本机用户路径 |
| 疑似 Secret 命中复核 | VALID / 未发现真实秘密 | 两个赋值命中分别为示例占位值和空变量跨行接到下一项配置的误报；没有输出或在报告中复制秘密值 |
| 本地接口攻击输入验证 | VALID / 通过 | 非公开 ID、恶意 visitorId、超量批次、超大请求体、超限排名参数、恶意 Origin、匿名 admin 被拒绝；换 UUID、绑定分支限流差异、Turnstile hostname/action 未检查得到复现 |
| 更新页恶意属性渲染 | VALID / 通过 | 注入引号的 route/title/image fixture 被转义；未知查询过滤项被丢弃；VM 无网络 |
| npm 公告检查 | VALID / 完成，存在公告 | 主锁 2 个 high 包；Worker 锁 1 high + 2 moderate 包（包含传递包装包）；APK updater 锁 0；不是三个“线上高危接口” |
| 云平台管理权限、存储写权限 | NOT_RUN | 未修改线上权限；需要所有者核对控制台，未做写入试验 |
| workers.dev 备用入口 | 未验证 | 配置启用；本次 DNS 失败，不推导为安全关闭或服务故障 |

本地验证运行于 Node.js 24.15.0，Actions 配置使用 Node 22。构建使用公共 Stats URL 和提醒启用标志；本地没有装入私有 Secret 或真实 Turnstile site key。报告里的线上 widget 存在性来自生产 HTML，而不是本地构建。

### 线上只读观测

| 对象 | 结果 | 可以证明什么 |
| --- | --- | --- |
| 主站 HTTPS 首页 | 200 | 有 HSTS；无 CSP/header 或 CSP meta、X-Frame-Options、显式 Referrer-Policy、Permissions-Policy、nosniff |
| 主站 HTTP 首页 | 301 → HTTPS | 当前主机入口升级到 HTTPS |
| 主站 `/.env`、`/.git/config`、`/catalog/index.json` | 各 404 | 这些路径没有在当前 Pages 中公开；原始 Catalog 仍是公开 Git 文件 |
| API `/health` | 200 | `registryHash=d9c633e9e338b9c7cee2a0e41781c1456a1125e3c1bda03e36d83f6db5a9e584`，与本地 registry 一致 |
| API 匿名 `/v1/admin/update-reminders` | 401，通用 unauthorized | 该匿名入口当前被拒绝；不证明所有 Secret 设置或管理员 Token 强度 |
| API ranking `limit=51` | 400 | 排名上限检查在生产生效 |
| API health 带恶意 Origin | 403 | 外站 Origin 不在白名单 |
| API OPTIONS 带主站 Origin | 204，准确回显主站 Origin | 不是 API 任意 Origin 的通配 CORS |
| ROS `?list-type=2&max-keys=1` | 403 AccessDenied | 当前匿名列目录被拒绝；不证明单对象 GET 或写权限 |
| 一个已在页面公开的 WebP，HEAD | 200，image/webp，nosniff，HSTS | 此公开资源类型和浏览器读取配置正常，不代表所有对象一致 |

API health 的 Catalog 时间与原始 Catalog 的最新时间不同，但 registryHash 一致。此处应以生成的公共 registry 内容哈希核对授权资源集合，不能只因时间不同就判定部署不安全。

## 当前真正的攻击入口

1. **GitHub Pages**：浏览器下载固定 HTML/JS/JSON，在本机做搜索、过滤、详情切换和 ZIP 打包；没有本站登录、上传、服务端搜索或文件系统读取接口。
2. **Stats Worker + D1**：公开读总量/榜单/资源计数；匿名写访问、详情、下载事件和更新提醒；管理提醒状态的接口单独要求 Bearer Token。这是最主要的服务端动态攻击面。
3. **ROS/CDN**：浏览器直读公开图片/下载文件。静态站不转发字节、不接受任意 URL 代取。公开文件能被第三方链接，可能消耗存储出口流量。
4. **APK 更新 CI + GitHub Releases**：定时/手动从固定官方源获取 APK，经本地校验后用 CI 凭据发布；这是维护者/供应链边界，不是访客可调用的上传服务。
5. **第三方组件**：反馈页的 Giscus 和提醒区的 Turnstile。评论存在 GitHub 上，不进入本站 raw HTML 模板；外部加载器脚本仍有所在页面的脚本权限。

## 实际问题与处理建议

### M1：匿名统计可以人为制造（中风险）

**哪里有问题**：`workers/stats/src/core.ts` 的 `validateEventPayload`、`recordEvent`；`apps/site/src/lib/stats-client.ts` 的 visitorId 持久化。visitorId 是自选 UUID，作为去重键而非可信身份；下载事件不核实 ROS 是否实际传输了文件。单个资源下载客户端还在 fetch 开始前报告事件。

**别人怎么利用**：脚本无需真的访问详情/下载文件，可以提交合法事件，轮换 UUID 或等待 10 秒下载去重窗口。缺少 Origin 的命令行请求被允许，这是公开 API 的现有设计。CORS 只能限制浏览器跨站读取，不能认证脚本。

**最坏后果**：热门榜、访问数和下载数失真；在限流额度内增加 D1 写入；多 IP 持续滥用可能增加费用或削弱 API 可用性。没有因此获得任意写 Catalog、写存储、管理员权限或个人记录读取能力。

**当前严重程度**：中。真实匿名入口已确认；存在限流、资源白名单和去重，不能无限单 IP 无成本写入。不是“数据库任意写入”漏洞，统计写入本就是公开功能。

**建议**：先处理 M2；将计数理解为“客户端报告的交互次数”，不要当作真实独立用户或成功文件下载凭证。持续观察事件数量与页面流量是否显著不符，设 D1/Worker 用量告警。受到实际刷榜时再对写事件增加适度挑战或短期聚合保护，无需加用户登录系统。只检查 Origin 或隐藏 API 地址不能解决。

**是否修复**：未改。这会改变计数/访问行为，应由所有者选择策略。本地已证明两个不同 UUID 均被接受；没有往线上刷一次计数。

### M2：生产用原生绑定时，较严格的接口限流阈值不生效（中风险）

**哪里有问题**：`workers/stats/src/core.ts` 的 `requestRateLimitConfig` / `checkRequestRateLimit`；`workers/stats/wrangler.toml` 的 `RATE_LIMITER`。

代码按接口声明事件 60 次/分钟、提醒 20 次/10 分钟、读接口 120 次/分钟。但存在 `RATE_LIMITER` 时，只传 `scope:clientKey` 调用绑定，随后立即返回；不会执行 D1 的 `windowMs/maxRequests` 检查。该唯一绑定实际配置为 **120 次/60 秒**，所有 scope 都采用这个配置。

**别人怎么利用**：持续合法请求可超过源码显示的严格额度：事件额度是回退逻辑的两倍；提醒的名义持续速率是回退逻辑的 60 倍。scope 分开计数，不能把一个 scope 的 120 当成所有 API 的总预算。提醒仍受 Turnstile（如果 Secret 存在）及同 UUID/游戏去重约束。

**最坏后果**：比维护者以为的更容易污染统计、放大 D1 写入和提醒请求的验证码校验成本。不是直接的无限制 DoS，邮箱发送还有 cycle、领取 lease、重试次数等限制。

**当前严重程度**：中。配置/分支差异明确，纯内存验证显示无绑定事件第 61 次返回 429，有成功绑定分支时第 61 次继续处理。没有线上探测阈值；控制台是否覆盖本地绑定配置尚未实时读回。

**建议**：核实生产实际绑定；决定需要统一 120/min 还是按接口区分。如果需要严格区分，为事件/提醒选择合适的独立绑定或明确的服务端窗口规则，并让文档/测试覆盖绑定分支。不要简单把 namespace 全局降到 20 而同时伤害正常读接口。Cloudflare 原生绑定按地点工作且为近似计数，不是全球强一致限额，也不能独自抵御多 IP 滥用。[官方限流说明](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)

**是否修复**：未改 Cloudflare 配置或 Worker。需要策略和部署选择。

### C1：隐藏资源不是私密资源（有现实条件的边界风险）

**哪里有问题**：公开 `catalog/index.json` 包含 4348 条资源和 20136 个对象；页面公共投影有 3977 条资源。371 条不在页面投影中，原因包括类型隐藏、缺少可展示资产、draft/tombstone 等；它们关联的 rendition 涉及 687 个对象引用。完整 Catalog 有 89 个 draft 和 4 个 tombstoned 状态。

**别人怎么利用**：阅读公开 Git Catalog 即可了解这些资源的元数据、ID、来源相对路径和关联对象键，不需要猜 UUID。若对应对象也允许匿名 GET，就能按键直读；拒绝列目录不阻止这种已知键读取。

**最坏后果**：如果将未来私人、未批准或不应公开的源文件放在同一公开 Catalog/对象区，仅隐藏 UI 无法保护它们。当前确认的是元数据可见；本次没有下载隐藏对象，也没有证据表明其中存在私人内容。

**当前严重程度**：当前按低风险公共边界提醒处理；如果有“这些内容必须保密”的实际要求，则升为中风险或依文件性质更高。前端不展示的公开游戏资料不是自动成立的数据泄露。

**建议**：明确 Catalog 是公开资料，不放私人来源/凭据/未授权文件；真正私密对象应留在 Workspace/私有存储边界。不要尝试靠资源 ID、SHA-256 或 `lifecycle.status` 做鉴权。核对 ROS 中是否有私有文件和源 APK/原始包，只核对所有者自己的配置/清单。

**是否修复**：未改 Catalog、存储 ACL 或对象；这涉及公开/私有边界，不适合自动删数据。

### C2：Turnstile 的配置失误保护有限（低风险，条件满足时可升中）

**哪里有问题**：`verifyTurnstileToken` 只要求 Siteverify 返回 `success === true`，不校验 `hostname` / `action`；`handleRequest` 只在 `TURNSTILE_SECRET_KEY` 非空时要求 token。前端 widget 是否显示与后端 Secret 是否存在是两套配置。

**别人怎么利用**：若同一 widget 允许过宽域名、跨用途复用，攻击者可能把其他获准域名/用途的有效 token 用在本站提醒；Secret 误删则提醒接口退回不要求验证码。不能伪造任意 token 绕过已经启用的 Siteverify，Cloudflare 还校验 token 的有效期和单次使用。

**最坏后果**：增加虚假提醒/计数和请求成本；邮件只能发固定配置的站主地址，不能指定收件人发送任意内容。不是开放邮件中继。

**当前严重程度**：低/条件性。生产首页存在 widget，但本次没有核实 widget 域名列表和后端 Secret，未发送可能有效的提醒来探测。mock Siteverify 返回错误 hostname/action 仍获 202，确认源码缺少该检查。

**建议**：生产 widget 限于实际主站，不允许 localhost 或无关域名；为提醒指定 action，后端校验返回 hostname/action。若业务要求提醒必须有验证码，增加明确的“要求验证码”配置，并在缺 Secret 时拒绝，而不是只依据 Secret 存在与否开启。这个改变需要部署和正常用户回归。[服务端验证说明](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/)；[生产测试配置建议](https://developers.cloudflare.com/turnstile/troubleshooting/testing/)

**是否修复**：未改验证码或 Secret 配置。

### H1：更新页链接属性缺少一致的 HTML 转义（低风险，已修复）

**哪里有问题**：`apps/site/src/scripts/updates-page.ts` 用字符串拼接 `innerHTML`，标题、图片 URL 已转义，但详情链接和 preview route 原来直接插入双引号属性。

**别人怎么利用**：需要控制生成数据中的 route/basePath 或引入新的不可信数据源，才能利用引号逃出属性。当前 route 来自固定 `/r/<UUID>/`，查询参数只选择过滤项，因此本次没有找到普通访客可利用的入口。

**最坏后果**：未来若错误地把外部 route 原样接入，可能形成属性注入/XSS；若攻击者已有任意源码写权限，则已经有更直接的执行方式。

**当前严重程度**：低，防止后续维护失误的加固，不宣称修复了可由搜索链接利用的 XSS。

**建议/修复**：复用现有 `escapeHtml`，统一转义详情和 preview 的 href，共两处，正常 URL 不变。已验证恶意 route/title/image fixture 不会逃出属性，完整门禁通过。HTML 转义不等同 URL 协议校验；当前 route 的安全仍依赖受验证的内部生成链。

**是否修复**：已本地修复，未部署。

### H2：依赖公告存在，但目前不是公开站的高危入口（低风险维护项）

| 锁文件 | 命中与版本 | 本项目可达性判断 | 建议 |
| --- | --- | --- | --- |
| 根 `package-lock.json` | Astro → `devalue 5.9.0`；Astro → unifont → `undici 8.10.0`；npm 计 2 high 包 | devalue 公告涉及特制反序列化/序列化、共享内存、CPU 放大等；本站没有公开 Astro Actions/session/SSR。undici 在构建字体工具链，主站是静态产物；没有本站 BalancedPool、自定义 TLS 回调、WebSocket 或共享 Cookie 缓存入口 | 后续维护批次按上游修复版更新这两个传递包并验证锁文件/构建，不执行 `audit fix --force` |
| `workers/stats/package-lock.json` | Wrangler 4.133.0 → Miniflare → `undici 7.29.0`；npm 计 1 high + 2 moderate 包 | 此锁是 Wrangler 开发/部署工具链；生产 Worker 使用 Cloudflare runtime fetch，源码不导入 undici/Miniflare/Wrangler | 维护时升级兼容的 Wrangler/传递依赖；本次 npm 提供 Wrangler 4.147.0 非 major 修复路径，生产部署需单独决定 |
| APK updater 锁 | 当前 0 公告 | 没有公告不等于供应链绝对安全；CI 会带发布/ROS 凭据运行更新器 | 保持独立锁、固定源 URL、凭据最小权限 |

undici 官方公告给出的修复版本包括 7.29.1 / 8.10.2；其中 TLS 问题仅影响使用函数型 TLS/connect 配置的 BalancedPool，而不是所有 HTTPS fetch。[undici 公告](https://github.com/advisories/GHSA-w293-vg96-wgc3)；[devalue 公告入口](https://github.com/advisories/GHSA-j22f-vq7h-c4qm)

三个锁文件的 resolved 下载地址均为 npm 官方 registry，未发现缺失 integrity 的 registry 包。hasInstallScript 包是 esbuild、fsevents、workerd 及 Wrangler 内部 esbuild，属于已有工具的平台安装链；没有业务自定义安装脚本或明显无关的下载器。仍需信任 npm 发布者，integrity 只能固定已锁定的包，不能证明包发布者永不被攻陷。

根 AWS SDK 用于现有存储/APK 工具，不是浏览器获得的 S3 写权限；没有为了消除 warning 而删除它。**是否修复：未改依赖或安装行为。** 此类升级可能影响构建/部署工具，不归入本站已证实中高危漏洞。

### H3：缺少显式浏览器响应策略（一般加固）

主站已 HTTPS、HTTP 跳转和 HSTS，但生产首页没有 CSP、frame 限制、nosniff、显式 Referrer/Permissions Policy；API JSON 也没有 nosniff。公开图片观测有 nosniff。

可能的影响：未来出现脚本注入时没有额外 CSP 防线；页面可被第三方 iframe 包装；不能把未设置 Referrer-Policy 解读为现代浏览器默认泄露完整跨站搜索 URL——通常已有 strict-origin-when-cross-origin 默认。Permissions Policy 缺失也不会自动绕过用户的摄像头/麦克风授权。本站没有登录或交易，点击劫持的当前影响主要是误导点击和下载，严重程度低。

建议：低成本显式设置 `Referrer-Policy: strict-origin-when-cross-origin`、`X-Content-Type-Options: nosniff`；不需要摄像头/麦克风/定位时可禁用这些能力。frame 规则应确认是否要允许他人嵌入。CSP 要覆盖内联主题/图片 fallback 脚本、Giscus、Turnstile、ROS 图片/fetch 和 ZIP blob 下载，先测试再部署，不能直接套 `default-src 'self'` 造成页面故障。`frame-ancestors` 需要响应 header，不能靠 CSP meta 达成；Permissions Policy、nosniff 也不能用伪造 meta 替代。

当前是 GitHub Pages，不是 Cloudflare Pages；不要以为给仓库添加 `_headers` 就能控制 GitHub Pages 响应。能够设置哪些策略需要与托管方案匹配，迁移/代理属于另一个决定。**是否修复：未修改线上托管或追加未经回归的 CSP。**

### H4：第三方脚本和 APK 发布链仍是供应链信任点（条件性风险）

Giscus 加载器在反馈页运行，Turnstile 加载器在提醒区运行；被加载的脚本可读取所在页面的 DOM/localStorage。若供应方被攻陷，后果可能是页面篡改、伪造下载链接或获取匿名 ID。当前没有证据表明供应方异常。Giscus 的主题 postMessage 指定 `https://giscus.app`，没有接收任意来源消息并执行的本站 handler；评论内容在跨域 iframe 中，不能等同本站未转义评论 XSS。

APK 更新器固定官方 API/CDN hostname、HTTPS、重定向次数和每跳主机检查；限制文件大小、使用 canonical 文件名、部分文件清理并计算 SHA-256；ZIP 校验不解压到服务器目录。因此它不是任意 URL 抓取器或 Zip Slip 入口。但 `validateArcaeaApk` 只验证大小、ZIP/AndroidManifest、文件名和散列，**没有证明 Android 发布者签名**。若上游/CDN 或发布流程被侵入，恶意 APK 可能仍通过这些结构校验；自行计算的 SHA-256 只能证明下载/发布的一致性，不能证明作者身份。

建议：保留固定供应源；避免新增第三方脚本；如要把 APK 镜像当作高可信发行渠道，后续考虑验证预期签名证书及签名有效性，先处理合法证书轮换兼容，不自行改变发布流程。**是否修复：未调整第三方组件或 APK 发布规则。** 不把“上游可能被攻陷”列为已经发生的高危漏洞。

### H5：匿名统计最小化较好，但访客说明与历史留存仍可改善（低风险）

浏览器 localStorage 长期保存随机 visitor UUID；API 接收事件类型、公开资源 ID 和 UUID。服务端去重短期保留 UUID/资源，site/view 为 30 分钟、download 为 10 秒；reminder cycle visitor 24 小时；日汇总保留 35 天，累计计数长期保留。IP 用日期和 Secret 加盐散列生成短期限流键，代码不保存原始 IP、UA、地理位置或搜索词。Secret 缺失会用公开默认盐，弱化 IP 散列的不可猜测性，建议核实生产 Secret；不要把散列称为不可逆匿名化保证。

公开读接口只返回聚合计数和公开资源 ID，没有按 visitor 查询历史的路由。旧 `update_reminders` / `update_reminder_rate_limits` 表已停写但没有自动删除，迁移可能留下历史 UUID/时间；当前远端旧表行数未读取，不能声称已清空。提醒返回站主处理状态/时间汇总，未返回其他访客 ID 或邮件收件人。

建议：在访客可见说明中简要交代匿名 ID、去重、第三方组件和清除浏览器数据的影响；评估旧表数据是否仍需保留，备份后由所有者处理。Cloudflare/GitHub/ROS 自身访问日志可能含 IP，与应用 D1 最小化是两回事，平台日志保留未在本次检查。**是否修复：未删除线上历史记录或新增统计。**

### H6：CI 和秘密防误提交仍需少量人工核对（低风险/待确认）

已确认的措施：全部 Actions 使用完整提交 SHA；PR workflow 是 `pull_request`、contents:read，没有 `pull_request_target`，不注入发布 Secrets；Pages build 默认 contents:read，deploy job 才有 pages:write/id-token:write；Cloudflare Secret 只进入 main 上部署 Worker 的步骤；APK job 的 contents:write 用于现有 Release 发布且 checkout 禁止持久化凭据。base SHA 经 env 传入并引用，没有 PR 标题/分支名直接插入 shell。

条件性问题：APK 手动 mode 用 `${{ inputs.mode || 'publish' }}` 直接插进 shell 双引号。当前是 choice 输入，dispatch 需要写权限，未找到匿名/PR 注入入口；不要将其描述为任意访客 RCE。后续可通过 env 传值并按 shell 变量引用；CLI 的枚举检查发生在 shell 之后，不能代替 shell 边界检查。

需要核对：`stats-production` Secret 的批准规则、main 分支保护、Actions 默认权限、只有授权 Action 可执行的策略、Cloudflare Token 是否仅部署目标 Worker、ROS Key 是否仅有必要 bucket/prefix 权限。workflow 的 `environment` 名字本身不证明启用了审批。APK 的 npm 安装发生在带 contents:write 的 job；当前 Secrets 只在后续运行步骤注入，但同 job 的被攻陷安装/依赖可以留后门等待这些 Secrets，因此锁文件和上游仍值得关注。Pages checkout 默认保留只读 token，属于可进一步缩小的凭据暴露，不是已发现的写权限提升。

`.gitignore` 已覆盖 `.env*`、`.dev.vars*`、`.npmrc`、私钥、日志、dist/build、生成投影和本地 Worker 状态，抽样 `git check-ignore` 通过。当前三个被忽略 `.npmrc` 只有 cache/logs 配置键，没有 token 键。没有已跟踪 Secret 文件；`PUBLIC_*` 是会暴露给浏览器的配置，应只放站点 URL、公开 site key 等值。没有自定义 Git hook 或 SSL 校验禁用配置证据；不要用 `git add -f` 绕过忽略，不要把所有者凭据放进 Public。

Git 历史仍有 20 次本机路径命中，分布在 11 个旧文档/CSV blob；当前已跟踪文件与本次产物无这些命中。它们透露旧目录布局，不能让访客读取本机磁盘，按低风险历史信息处理，不建议为了清除路径重写整个历史。若今后确认真实 Secret 泄露，先撤销/轮换，再考虑历史和 artifact 清理；仅删当前文件不足够。

**是否修复：未变更 workflow、平台权限、分支规则或忽略策略。** 用户要求部署/Secrets/权限改动先提供建议，本次保持该边界。

## 其他检查结果：哪些风险不成立

| 风险 | 本项目判断与原因 |
| --- | --- |
| 搜索/过滤参数 XSS | 未发现可利用链。搜索词用于 input.value/匹配和编码后的 URLSearchParams，结果标题使用 textContent；游戏/分类等是白名单或过滤，不作为 HTML 执行。没有 eval/new Function/document.write |
| `innerHTML` 都是漏洞 | 不成立。统计图标是固定 SVG；下载按钮恢复的是已有本地 DOM；Updates 原有文字/图片转义，链接已加固。三处 JSON `set:html` 都转义 `<`，阻止 `</script>` 逃逸；数值尺寸来自校验后的构建数据 |
| URL/开放跳转 | 未发现接收 `url=`/`redirect=`/`next=` 并导航的公开接口。详情 prev/next/return 来自本 tab sessionStorage，并检查同源；URL 查询里的 token 只找快照，不能指定外站。APK manifest 验证 HTTPS、固定 GitHub Release 路径和官方 CDN，不接受 javascript/data 等协议 |
| 任意请求/SSRF/开放代理 | 不适用静态前端；Worker 只请求固定 Turnstile/Resend 地址且有超时，不接受用户 URL；APK 的每跳重定向也校验固定 CDN。没有服务器批量下载代理或文件上传/托管 API |
| SQL 注入 | 未发现。用户字段经 UUID、game、period、limit 白名单检查，SQL 用 bind；IN 列表只按受限数量生成问号，不拼接用户 SQL。请求体限制 16 KiB，资源批次最多 100，排名最多 50 |
| 未授权管理写入 | 未发现。提醒 list/resolve/retry 先要求配置的 Bearer Token，缺 Token 失败关闭；匿名线上 list 返回 401。管理 Secret 不在客户端；公开统计写入是受约束的预期功能 |
| 目录穿越/任意本机文件 | 静态站没有按用户 path 读文件的服务。资源 route 是 UUIDv7；objectKey 限于 objects/assets + 64 位 hex + 扩展段。批量 ZIP 文件名去除斜杠、控制字符、纯点名，不能生成 `../../` 路径；ZIP 在访客浏览器生成 |
| 服务端 ZIP bomb/Zip Slip | 无访客上传/解压服务。批量下载 30 文件、300 MiB、并发 3，按流实际字节限制，在本机 ZIP 打包。单文件 Blob 下载仍依赖可信生成 URL，非本站服务端内存耗尽入口 |
| CSRF 登录/账户接管 | 本站没有登录账户或 Cookie 认证的业务写接口，不适用传统用户账户 CSRF。Admin Bearer 不是浏览器自动附带 Cookie；匿名统计仍有 M1 的滥用风险 |
| 图片/下载链接注入 | 当前来自受验证 Catalog 的 hash objectKey 和维护者控制的 ROS base，不从用户查询参数生成。协议/hostname 防线对 APK 更严格；未来引入外部 JSON 时应重新评估，不假设所有 fetch JSON 永远可信 |
| CORS 任意权限 | API 不是 `*`；localhost/127.0.0.1 在源码允许列表，建议生产与开发分开，但当前不构成 admin 越权。GitHub Pages 静态文件和 ROS 公开图片的 `*` 便于公开读取，不等于写许可。ROS 回显 `*` 与 credentials:true 的组合不使浏览器凭据读取生效；客户端下载用 credentials:omit；未测试存储写权限 |
| 客户端暴露源码/公有配置 | 公有 JS、resource ID、D1 ID、Account/仓库/widget ID 和 public URL 不是密码。产物中没有 source map 或私有凭据扫描命中；API 错误是通用错误码，没有客户端 SQL/堆栈。服务端 console 日志需按平台留存权限管理 |
| 第三方用本站批量放大流量 | 没有服务端代打包或 URL 转发放大。别人可以直接 hotlink 公共 ROS 文件消耗出口，这是公开下载的现实运营风险；推荐费用告警/缓存，不能承诺 Referer 限制阻止脚本或盲目开启会破坏 ZIP fetch 的防盗链 |

## 所有者后续清单（不需要新架构）

1. **优先核对 M2**：查看 Stats Worker 的真实绑定额度，选定事件/提醒策略，再进行一个独立且可回归的 Worker 配置批次。
2. **确认公开/私有界线**：Catalog 和公开 bucket 中只放可公开材料；核对 bucket 匿名读/列举/写策略，以及 ROS CI Key 的权限范围。本次列举拒绝是好证据，仍不能代替完整 ACL 审核。
3. **核实 Turnstile 和 Secrets**：widget 域名、backend Secret、RATE_LIMIT_HASH_SECRET、admin Token 强度；不要贴 Secret 值到聊天或报告。
4. **小批次维护工具依赖**：采用上游兼容修复版本，审查锁文件差异；无需大版本自动升级或另建复杂漏洞流水线。
5. **检查发布权限与费用**：main 保护、stats-production 环境规则、Cloudflare/ROS 最小权限和 Worker/D1/ROS 用量告警；需要时再制定 CSP/iframe 策略。

随着访问量增加，最值得持续关注的五点是：**统计异常与按接口限流；D1/Worker/ROS 的成本和额度；公开 Catalog/对象的边界；带发布凭据的依赖/Actions/APK 供应链；Turnstile 与管理员 Secret 配置是否保持有效。** 不需要为这个静态下载站增加登录系统、用户数据库或企业级鉴权架构。

## 本次交付边界

保留现有视觉和正常产品行为；只做更新页属性转义，无重构、新依赖、新 CI、永久审计脚本或重复测试框架。完整门禁后的修改仅为本报告，不使已通过的代码/构建证据失效。

本次临时扫描脚本、内存验证和命令日志存于带标记的 Workspace task，完成后清理；仅报告与两处源码加固纳入版本控制。标准生成位置的 dist、公共 JSON 与 Astro 缓存保持忽略，供本地预览和后续生成使用，不纳入提交；没有删除原先存在的缓存或未标记目录。Git 仅做限定路径的本地提交，**不 push、不部署、不轮换 Secret、不变更存储/Cloudflare/GitHub 权限**。线上观测是修复前的部署状态；本地修复不会在未发布时自动出现在网站上。
