import type { GameId, ResourceTypeId } from "./game-config";

export type CardMediaRatio = "square" | "wide" | "landscape" | "portrait" | "tall";
export type CardMediaFit = "cover" | "contain";

export function cardMediaRatio(game: GameId, resourceType: ResourceTypeId): CardMediaRatio {
  if (resourceType === "jacket") {
    const jacketRatios: Record<GameId, CardMediaRatio> = { arcaea: "square", phigros: "wide", rizline: "square" };
    return jacketRatios[game];
  }
  if (game === "rizline" && (resourceType === "special-art" || resourceType === "character-avatar")) return "square";
  if (game === "rizline" && resourceType === "track-series") return "landscape";
  if (game === "rizline" && resourceType === "rizcard-layout") return "portrait";
  if (resourceType === "character-avatar" || resourceType === "sticker" || resourceType === "linkplay-preview") return "square";
  if (resourceType === "character-portrait" || resourceType === "world-mode" || resourceType === "startup") return "portrait";
  if (resourceType === "story-cg" || resourceType === "background" || (game === "phigros" && resourceType === "pack-cover") || resourceType === "phigros-april-fools") return "wide";
  if (resourceType === "pack-cover") return "landscape";
  if (resourceType === "story-texture") return "landscape";
  return "landscape";
}

export function cardMediaFit(game: GameId, resourceType: ResourceTypeId): CardMediaFit {
  if (game === "rizline" && ["track-series", "rizcard-layout"].includes(resourceType)) return "contain";
  if (["character-portrait", "character-avatar", "linkplay-preview", "sticker", "story-texture", "pack-cover"].includes(resourceType)) return "contain";
  return "cover";
}
