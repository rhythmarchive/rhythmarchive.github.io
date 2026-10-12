# Public UI 基础

网站保留蓝色与青色强调、浅色档案背景、深色主题和以资源图片为主的卡片展示。首页、资源列表、详情和剧情地图具有不同的信息密度，不要求使用同一种布局。

## 样式入口与复用

- `apps/site/src/styles/global.css` 管理主题、页面容器、标题、通用字段、按钮、筛选、卡片和状态面板。
- `local-library.css`、`media-gallery.css` 只管理收藏与媒体视图的专用布局；普通控件复用全局规格。
- 资源卡片继续使用现有 `CardShell.astro`、`card-view-model.ts` 和 `render-resource-card.ts`，分别覆盖静态与动态渲染，不另建卡片实现。
- 剧情地图的深色画布、节点形状与摄影机控件保留在 `story-atlas.css`。其游戏内视觉语义不套用普通资源列表的样式。

## 视觉与布局规格

| 用途 | 现有入口与规格 |
| --- | --- |
| 页面宽度 | `.page-container`，最大 1320px，桌面两侧 24px，600px 以下两侧 14px |
| 列表页标题 | `.page-heading`，共用 `--page-title` 与 `--page-head-space`；搜索居中、反馈页装饰和更新详情宽度由页面保留 |
| 正文与辅助信息 | `--text`、`--text-muted`、`--text-soft`，使用主题变量，不另写局部灰色 |
| 圆角 | `--radius-sm: 9px` 用于控件与缩略图；`--radius-md: 14px` 用于卡片与媒体画布；`--radius-lg: 20px` 用于浮层 |
| 原生输入与选择框 | `--control-height: 40px`，600px 以下 44px；同一背景、边框、内边距与焦点规格 |
| 密集切换按钮 | `--control-compact: 36px`，600px 以下 44px；沿用现有按钮组和标签形状 |
| 选中状态 | `--control-selected` 与 `--accent-strong`；语义使用 `aria-selected`、`aria-pressed` 或 `aria-current` |
| 键盘焦点 | `--focus-ring`，3px 描边；搜索框使用同色外环，专用地图继续使用画布焦点样式 |
| 空状态 | 搜索、收藏、更新共用面板边界、背景、间距；对齐方式与恢复动作按场景保留 |

页面标题可在原有容器添加 `.page-heading`，不必为不同标题创建新的组件。通用字段的共享选择器列出真实使用者；新增使用者应加入现有规则，页面自己的 CSS 仅保留宽度、布局等差异。

## 交互与响应式

原生 `button`、`select`、`details` 优先。链接负责导航，按钮负责操作。禁用按钮不呈现可点击的悬浮抬升；禁用与加载状态不能仅靠鼠标指针区分。资源卡片的键盘焦点与鼠标悬浮共享边界反馈。

所有页面通过 `BaseLayout` 提供“跳到主要内容”。分类导航标注当前页。标签页继续复用已有键盘与 ARIA 实现，不为视觉统一另建交互逻辑。

移动端保留横向分类导航、折叠筛选、两列资源卡片和底部批量工具栏。筛选标签可换行，长标题可断行；根容器不再强制 320px 最小宽度，避免 320px 视口存在滚动条时裁切右侧内容。图片、视频和地图可以有各自的内容布局，普通控件仍遵守共享规格。

视觉基础不增加客户端依赖、全局脚本或额外网络请求。验证 UI 时覆盖桌面、平板和窄屏，以及浅色、深色、焦点、选中和空状态；业务验证沿用现有相关测试。

## 动效与过渡

共用 `--motion-fast: 140ms`、`--motion-ui: 180ms`、`--motion-surface: 220ms` 和 `--motion-ease: cubic-bezier(.22, 1, .36, 1)`。普通反馈最快，页面过渡其次，偶尔出现的浮层稍长；交互结果立即更新，不等待动画。

| 场景 | 行为与边界 |
| --- | --- |
| 页面导航 | 原生跨文档 View Transition，页面短淡化、页头稳定。不改为客户端路由，不预取页面或图片；浏览器不支持时正常导航 |
| 图片详情 | 只对实际加载的可见图片及主动切换的面板短淡化；原图、超分与难度差分仍沿用既有按需加载和错误回退 |
| 大图开合 | 桌面从当前预览几何位置展开并回收，保持图片比例；触屏只淡化。使用已请求的当前图片，不克隆预览或预取邻图 |
| 浮层与多选栏 | `motion.ts` 统一显隐；退出期间立即 inert，完成后 hidden。快速反向操作从当前状态继续，旧回调不能隐藏重新打开的浮层 |
| 列表内容 | 客户端数据更新后只对容器短淡化，不逐卡片错峰。触屏长列表跳过整体动画。多选使用既有 syncCards，保持卡片节点和焦点 |
| 按钮与下载 | 统一颜色、边界和轻微按压反馈；下载期间 disabled 与 aria-busy。触屏不保留悬浮抬升，选中卡片不位移 |

`prefers-reduced-motion: reduce` 不启用页面过渡，JavaScript 动效直接完成状态更新；原有 CSS 减少动态效果规则继续生效。只动画 opacity 和 transform，不动画布局尺寸、滤镜或模糊，不常驻 will-change、滚动监听、动画循环或图片观察器。

参考了 [ADX 的页面过渡实现](https://github.com/AdingApkgg/adx-dl/blob/main/apps/web/src/app/page-transition.tsx)及其[共享样式](https://github.com/AdingApkgg/adx-dl/blob/main/apps/web/src/app/globals.css)中稳定页头、统一短过渡和渐进增强的做法。本项目保留 Astro 多页面结构，采用更短的淡化，不引入其 React 路由、视差、倾斜或主题扩散效果。原生跨文档行为参见 [Chrome View Transitions 文档](https://developer.chrome.com/docs/web-platform/view-transitions/cross-document)。
