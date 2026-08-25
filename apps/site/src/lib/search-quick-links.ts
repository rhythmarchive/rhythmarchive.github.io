import type { GameId, ResourceTypeId } from "./game-config";
import type { PublicSiteData } from "./types";

type QuickLinkDefinition = {
  game: GameId;
  category?: ResourceTypeId;
  label: string;
};

export type SearchQuickLink = {
  label: string;
  href: string;
  count: number;
};

const QUICK_LINK_DEFINITIONS: QuickLinkDefinition[] = [
  { game: "arcaea", label: "Arcaea" },
  { game: "phigros", label: "Phigros" },
  { game: "rizline", label: "Rizline" },
  { game: "infalsus", label: "In Falsus" },
  { game: "rotaeno", label: "Rotaeno" },
  { game: "arcaea", category: "jacket", label: "Arcaea 曲绘" },
  { game: "phigros", category: "jacket", label: "Phigros 曲绘" },
  { game: "rizline", category: "jacket", label: "Rizline 曲绘" },
  { game: "infalsus", category: "jacket", label: "In Falsus 曲绘" },
  { game: "rotaeno", category: "jacket", label: "Rotaeno 曲绘" },
  { game: "rotaeno", category: "pack-cover", label: "Rotaeno 曲包封面" },
  { game: "rotaeno", category: "character-portrait", label: "Rotaeno 驾驶员立绘" },
  { game: "rotaeno", category: "story-cg", label: "Rotaeno 剧情 CG" },
  { game: "rotaeno", category: "startup", label: "Rotaeno 启动页面" },
  { game: "rizline", category: "special-art", label: "Rizline 特殊插画" },
  { game: "rizline", category: "track-series", label: "Rizline 精选集" },
  { game: "rizline", category: "rizcard", label: "Rizline Rizcard" },
  { game: "rizline", category: "character-avatar", label: "Rizline 角色头像" },
  { game: "arcaea", category: "character-portrait", label: "Arcaea 角色立绘" },
  { game: "arcaea", category: "story-cg", label: "Arcaea 剧情 CG" },
];

export function buildSearchQuickLinks(data: Pick<PublicSiteData, "games">): SearchQuickLink[] {
  return QUICK_LINK_DEFINITIONS.flatMap((definition) => {
    const game = data.games.find((candidate) => candidate.slug === definition.game);
    if (!game || game.count <= 0) return [];
    if (!definition.category) return [{ label: definition.label, href: `/${game.slug}/`, count: game.count }];

    const category = game.categories.find((candidate) => candidate.slug === definition.category);
    if (!category || category.count <= 0) return [];
    return [{ label: definition.label, href: `/${game.slug}/${category.slug}/`, count: category.count }];
  });
}
