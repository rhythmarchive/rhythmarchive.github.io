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
  { game: "arcaea", category: "jacket", label: "Arcaea 曲绘" },
  { game: "phigros", category: "jacket", label: "Phigros 曲绘" },
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
