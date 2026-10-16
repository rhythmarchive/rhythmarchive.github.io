export type Announcement = {
  id: string;
  date: string;
  title: string;
  paragraphs: string[];
};

// Newest first. Keep an existing id when correcting wording; use a new id for
// a new notice. Only the latest notice is included in the header's HTML.
export const announcements: Announcement[] = [
  {
    id: "2026-10-16-site-polish",
    date: "2026-10-16",
    title: "公告入口与首页体验更新",
    paragraphs: [
      "网站公告现在可以从右上角查看。新公告会展示一次，看过后不再自动展开，历史公告也会保留在这里。",
      "首页的游戏卡片更紧凑了，访问统计和资源浏览量加载时也会保留位置，减少页面跳动。",
    ],
  },
];
