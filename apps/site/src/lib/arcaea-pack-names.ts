import type { PublicResource } from "./types";

// Official zh-Hans_override names from assets/songs/packlistB in 韵律源点 7.2.0.
// APK SHA-256: 8622c5cf59adc775a19d973b634939cb461aad0b852c352f1215fcc4204d5dd1
// Keys retain the adopted international Browse names. Qualify generic append
// names with their parent game so separate collaboration chapters stay distinct.
// This module is build-time only; clients receive labels in their existing data.
const ARCAEA_PACK_NAMES: Readonly<Record<string, string>> = {
  "World Extend 4": "世界延展4",
  "Extend Archive 3": "延展档案3",
  "Extend Archive 2": "延展档案2",
  "Extend Archive 1": "延展档案1",
  "Divine Oblivion": "神圣毁灭",
  "Liminal Eclipse": "临界蚀影",
  "Lucent Historia": "流光史迹",
  "Silent Answer": "静默答复",
  "Final Verdict": "最终裁决",
  "Black Fate": "漆黑宿命",
  "Adverse Prelude": "冲突序曲",
  "Luminous Sky": "璀璨天空",
  "Vicious Labyrinth": "暴虐迷宫",
  "Eternal Core": "永恒核心",
  "Absolute Nihil": "绝对虚无",
  "Lasting Eden": "永恒伊甸",
  "Lasting Eden Chapter 2": "永恒伊甸·第二章",
  "Shifting Veil": "流转帷幕",
  "Extant Anima": "现世灵魂",
  "Chapter Experientia": "经验之章",
  "Esoteric Order": "奥秘哲理",
  "Pale Tapestry": "苍白织锦",
  "Light of Salvation": "救赎之光",
  "Divided Heart": "歧路心象",
  "Ephemeral Page": "浮生篇章",
  "The Journey Onwards": "续行之旅",
  "Sunset Radiance": "夕照辉光",
  "Absolute Reason": "绝对信念",
  "Binary Enfold": "双星交织",
  "Shared Time": "共度时光",
  "Ambivalent Vision": "矛盾视界",
  "Crimson Solace": "绯红慰藉",
  "DJMAX · Collaboration Chapter 2": "DJMAX · 第二章",
  "CYTUS II · Collaboration Chapter 2": "CYTUS II · 第二章",
  "WACCA · Collaboration Chapter 2": "WACCA · 第二章",
  "maimai · Collaboration Chapter 2": "maimai · 第二章",
  "maimai · Collaboration Chapter 3": "maimai · 第三章",
  "O.N.G.E.K.I. · Collaboration Chapter 2": "O.N.G.E.K.I. · 第二章",
  "O.N.G.E.K.I. · Collaboration Chapter 3": "O.N.G.E.K.I. · 第三章",
  "CHUNITHM · Collaboration Chapter 2": "CHUNITHM · 第二章",
  "CHUNITHM · Collaboration Chapter 3": "CHUNITHM · 第三章",
  "CHUNITHM · Collaboration Chapter 4": "CHUNITHM · 第四章",
  "Groove Coaster Chapter 2": "Groove Coaster · 第二章",
  "Lanota · Collaboration Chapter 2": "Lanota · 第二章",
  "Virtual Singers": "虚拟歌手",
  "UNDERTALE Pack Append": "UNDERTALE·追加曲包",
};

export function arcaeaPackName(value: string): string {
  return Object.hasOwn(ARCAEA_PACK_NAMES, value) ? ARCAEA_PACK_NAMES[value]! : value;
}

export function arcaeaPackLabel(value: string): string {
  const name = arcaeaPackName(value);
  return name === value ? value : `${value}（${name}）`;
}

/** Display and search only: source names, facet values and resource identity stay intact. */
export function localizeArcaeaPackNames(resource: PublicResource): PublicResource {
  if (resource.game !== "arcaea") return resource;
  const pack = resource.facets?.pack?.[0] ?? (typeof resource.metadata.pack === "string" ? resource.metadata.pack : resource.resourceType === "pack-cover" ? resource.displayTitle : undefined);
  const path = typeof resource.metadata.storyPathTitle === "string" ? resource.metadata.storyPathTitle : undefined;
  const translatedPack = pack && arcaeaPackName(pack) !== pack ? pack : undefined;
  const translatedPath = path && arcaeaPackName(path) !== path ? path : undefined;
  if (!translatedPack && !translatedPath) return resource;
  const title = resource.resourceType === "pack-cover" && translatedPack ? translatedPack
    : resource.displayTitle === translatedPath ? translatedPath : undefined;
  return {
    ...resource,
    ...(title ? { displayTitle: arcaeaPackLabel(title) } : {}),
    metadata: {
      ...resource.metadata,
      ...(translatedPack ? { pack: arcaeaPackLabel(translatedPack), packDisplayName: arcaeaPackLabel(translatedPack) } : {}),
      ...(translatedPath ? { storyPathTitle: arcaeaPackLabel(translatedPath) } : {}),
    },
    searchTerms: [...new Set([...(resource.searchTerms ?? []), ...[translatedPack, translatedPath].flatMap(value => value ? [value, arcaeaPackName(value)] : [])])],
  };
}
