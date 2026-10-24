export type Announcement = {
  id: string;
  date: string;
  title: string;
  paragraphs: string[];
  notify?: boolean;
};

// Announcements are editorial decisions, not a feed of commits or features.
// Newest first. Opt in with notify: true only for an important notice.
// Keep the id for wording corrections; version history lives in CHANGELOG.md.
export const announcements: Announcement[] = [
  {
    id: "website-v4-1-0",
    date: "2026-10-24",
    title: "Rhythm Archive v4.1.0 更新",
    notify: true,
    paragraphs: [
      "v4.1.0 新增 Dynamix 曲绘与角色立绘、Milthm 和 Berry Melody 曲绘库，并收录 In Falsus、Rizline 的新曲资源。",
      "完善多款游戏的谱面资料，切换曲绘时同步显示对应难度。定数分布图随难度、搜索和曲包筛选调整，修复分桶边界及返回列表后的同步；显示等级继续保留。",
      "首页音符轨道中的游戏图标可直接进入资源库，移除了“热门分类”快捷入口，并完善游戏版本显示。完整变化见下方“版本更新日志”。",
    ],
  },
  {
    id: "website-v4-0-0",
    date: "2026-10-16",
    title: "Rhythm Archive v4.0.0 更新",
    notify: true,
    paragraphs: [
      "v4.0.0 更新了界面、字体和动效，首页游戏卡片更紧凑，并调整了手机端布局与页面切换。主题和动效档位可在右上角设置。",
      "图库卡片统一画框，区间筛选支持点选和拖动；从详情返回时保留筛选与浏览位置。统计和热榜加载更连贯，Arcaea APK 入口也放到了首页首屏。",
      "以后可通过右上角查看重要公告，完整变化与历史版本见下方“版本更新日志”。",
    ],
  },
];
