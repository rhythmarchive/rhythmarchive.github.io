import type { Resource } from "../../../../packages/domain/src/schema.js";

export type GameId = Resource["game"];
export type ResourceTypeId = Resource["resourceType"];

export type GameConfig = {
  slug: GameId;
  displayName: string;
  categoryOrder: ResourceTypeId[];
  featuredCategories: ResourceTypeId[];
  filters: {
    difficulty: boolean;
    upscale: boolean;
  };
  metadataLabels: Record<string, string>;
};

export const CATEGORY_LABELS: Record<ResourceTypeId, string> = {
  jacket: "曲绘",
  "special-art": "特殊插画",
  "track-series": "专辑海报",
  "rizcard-layout": "Rizcard",
  "rizcard": "Rizcard",
  "character-portrait": "角色立绘",
  "character-avatar": "头像",
  "story-cg": "剧情 CG",
  "story-texture": "剧情贴图",
  "pack-cover": "曲包封面",
  background: "游玩背景",
  "linkplay-preview": "LinkPlay",
  sticker: "LinkPlay 贴纸",
  "world-mode": "世界模式",
  startup: "启动页面",
  "phigros-april-fools": "April Fools",
  other: "其他",
};

export const GAME_CONFIG: Record<GameId, GameConfig> = {
  arcaea: {
    slug: "arcaea",
    displayName: "Arcaea",
    categoryOrder: [
      "jacket",
      "pack-cover",
      "character-portrait",
      "character-avatar",
      "story-cg",
      "background",
      "linkplay-preview",
      "sticker",
      "world-mode",
      "other",
    ],
    featuredCategories: ["jacket", "character-portrait", "story-cg", "background", "pack-cover"],
    filters: { difficulty: true, upscale: true },
    metadataLabels: {
      artist: "曲师",
      pack: "曲包",
      packName: "曲包",
      side: "Side (APK)",
      version: "加入版本",
      releaseDate: "加入日期",
      bpm: "BPM",
      characterName: "中文名",
      characterJapaneseName: "日文名",
      characterEnglishName: "英文名",
      characterKoreanName: "韩文名",
      characterVariant: "角色变体",
      difficulty: "难度",
      difficultyTitle: "特殊难度名称",
      difficultyArtist: "特殊难度曲师",
      storyPathTitle: "剧情章节",
      specialYear: "愚人节年份",
      storyType: "剧情类型",
      storyChapter: "章节",
      storyEntry: "剧情 Entry",
      relatedSongTitle: "关联歌曲",
    },
  },
  phigros: {
    slug: "phigros",
    displayName: "Phigros",
    categoryOrder: ["jacket", "character-avatar", "pack-cover", "phigros-april-fools", "other"],
    featuredCategories: ["jacket", "pack-cover", "character-avatar", "phigros-april-fools"],
    filters: { difficulty: false, upscale: false },
    metadataLabels: {
      artist: "曲师",
      pack: "曲包",
      packName: "曲包",
      version: "版本",
      characterName: "中文名",
      characterJapaneseName: "日文名",
      characterEnglishName: "英文名",
      characterKoreanName: "韩文名",
      characterVariant: "角色变体",
      specialYear: "资源年份",
    },
  },
  rizline: {
    slug: "rizline",
    displayName: "Rizline",
    categoryOrder: ["jacket", "special-art", "track-series", "rizcard", "character-avatar"],
    featuredCategories: ["jacket", "special-art", "track-series", "rizcard", "character-avatar"],
    filters: { difficulty: false, upscale: false },
    metadataLabels: {
      artist: "曲师",
      musicArtist: "曲师",
      illustrator: "画师",
      trackSeries: "专辑海报",
      seriesName: "系列名称",
      disc: "Disc",
      character: "角色",
      characterName: "角色",
      layout: "Layout",
      layoutId: "Layout ID",
      songId: "歌曲 ID",
      gameVersion: "游戏版本",
      relatedSong: "关联歌曲",
      relatedSongs: "关联歌曲",
      collaborationPartner: "合作方",
      event: "活动",
      collaboration: "合作",
      hasOfficialStaticRender: "官方静态图",
      isRuntimeComposite: "运行时组合",
      componentRelations: "组成关系",
      description: "说明",
    },
  },
};

export function categoryLabel(resourceType: ResourceTypeId): string {
  return CATEGORY_LABELS[resourceType] ?? "其他";
}

export function gameCategoryLabel(game: GameId, resourceType: ResourceTypeId): string {
  if (game === "rizline" && resourceType === "character-avatar") return "角色头像";
  return categoryLabel(resourceType);
}

export function categoryOrderIndex(game: GameId, resourceType: ResourceTypeId): number {
  const index = GAME_CONFIG[game].categoryOrder.indexOf(resourceType);
  return index === -1 ? GAME_CONFIG[game].categoryOrder.length : index;
}

export function displayVariantLabel(variant: { variantKey: string; difficulty?: string | undefined; semanticStatus: string }): string {
  if (variant.difficulty) return variant.difficulty;
  if (variant.semanticStatus === "unresolved" || variant.variantKey.includes("256")) return "其他版本";
  const labels: Record<string, string> = {
    default: "默认",
    normal: "Normal",
    hires: "HiRes",
    poster: "Poster",
    banner: "Banner",
    cn: "中文版",
    "artwork-2": "变体 2",
  };
  const label = labels[variant.variantKey];
  if (label) return label;
  return "其他版本";
}
