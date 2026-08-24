import type { GameId, ResourceTypeId } from "./game-config";

export type PublicAsset = {
  url: string;
  width: number;
  height: number;
  mime: string;
};

export type PublicPreview = {
  small: PublicAsset | null;
  medium: PublicAsset | null;
  large: PublicAsset | null;
};

export type PublicDownload = {
  url: string;
  downloadFilename: string;
  mime: string;
  sizeBytes: number;
  width?: number;
  height?: number;
};

export type PublicVariant = {
  variantId: string;
  label: string;
  difficulty?: string;
  preview: PublicPreview;
  variantKey?: string;
  preferred?: boolean;
  original?: PublicDownload;
  originals?: PublicDownload[];
  upscaled?: PublicDownload;
};

export type PublicResource = {
  resourceId: string;
  route: string;
  game: GameId;
  resourceType: ResourceTypeId;
  category: string;
  categoryLabel: string;
  displayTitle: string;
  subtitle?: string;
  badges?: string[];
  searchTerms?: string[];
  sortOrder?: number;
  facets?: Record<string, string[]>;
  artist?: string;
  metadata: Record<string, string | number | boolean>;
  variants: PublicVariant[];
  preview: PublicPreview;
  original?: PublicDownload;
  upscaled?: PublicDownload;
  downloadFilename?: string;
  mime?: string;
  sizeBytes?: number;
};

export type PublicCategory = {
  slug: string;
  label: string;
  count: number;
};

export type PublicGameIndex = {
  slug: GameId;
  displayName: string;
  count: number;
  categories: PublicCategory[];
  featuredCategories: PublicCategory[];
};

export type PublicSearchEntry = {
  resourceId: string;
  route: string;
  title: string;
  game: GameId;
  category: string;
  categoryLabel: string;
  artist?: string;
  keywords: string[];
};

export type PublicSiteData = {
  generatedAt: string;
  resources: PublicResource[];
  games: PublicGameIndex[];
  searchIndex: PublicSearchEntry[];
  galleries: Record<string, PublicResource[]>;
};
