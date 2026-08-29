import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { ArcaeaStoryDerivatives, type ArcaeaStoryDerivativesType } from "../packages/domain/src/browse.js";
import type { Catalog, Resource } from "../packages/domain/src/schema.js";
import { validateCatalog } from "../packages/domain/src/validation.js";

const UI_EXACT_FILES = new Set([
  "act-bg.jpg", "act-title-backing.png", "act1-part1.png", "act1-part2.png", "act1-part3.png", "act2-part1.png", "act2-part2.png",
  "complete-banner.png", "completion-backing.png", "continue-btn.png", "corner-btn.png", "corner-btn-right.png", "partner-btn.png",
  "character_bg_panel_single_vert.png", "character_bg_panel_double_vert.png", "arrow_cover.png", "bottom_black.png", "top_line.png",
  "button_back.png", "button_continue.png", "button_finish.png", "button_next_chapter.png", "story_pack_divider_horizontal.png",
  "story_unlock_corner.png", "story_ex_line.png",
]);
const sourcePackageVersion = "7.0.0c";

type StoryIndex = {
  source: ArcaeaStoryDerivativesType["source"];
  paths: Array<{ characters: number[] }>;
  nodeIcons: Record<string, string>;
};

function normalize(value: string): string {
  return value.replaceAll("\\", "/");
}

function sourceFilename(resource: Resource): string | undefined {
  const candidates = resource.provenance.map((item) => normalize(item.sourceRelativePath));
  return candidates.find((item) => item.includes("/Arcaea/current-apk/")) ?? candidates[0];
}

async function sourceFile(packageRoot: string, resource: Resource): Promise<string | undefined> {
  const source = sourceFilename(resource);
  if (!source) return undefined;
  const relative = source.replace(/^.*?Arcaea\/current-apk\//u, "");
  const candidates = [
    path.join(packageRoot, "assets", ...relative.split("/")),
    path.join(packageRoot, ...relative.split("/")),
  ];
  for (const candidate of candidates) {
    try {
      const info = await stat(candidate);
      if (info.isFile()) return candidate;
    } catch {
      // The bounded investigation extraction may omit an unselected technical asset.
    }
  }
  return undefined;
}

function resourcePath(resource: Resource): string | undefined {
  const source = sourceFilename(resource);
  if (!source) return undefined;
  const relative = source.replace(/^.*?Arcaea\/current-apk\//u, "");
  return `assets/${relative}`;
}

function currentStoryUi(resource: Resource): string | undefined {
  if (resource.game !== "arcaea" || resource.resourceType !== "story-texture" || resource.lifecycle.status !== "published") return undefined;
  const source = resourcePath(resource);
  if (!source || !source.includes("/img/story/")) return undefined;
  const filename = source.split("/").at(-1);
  if (!filename || /(?:[_-]pressed|_disabled)\.png$/iu.test(filename)) return undefined;
  if (UI_EXACT_FILES.has(filename) || /^(?:entry_|cell[_-])[a-z0-9_-]+\.png$/iu.test(filename)) return filename;
  return undefined;
}

function usedCharacterIds(index: StoryIndex): Set<number> {
  return new Set(index.paths.flatMap((storyPath) => storyPath.characters));
}

function usedNodeIcons(index: StoryIndex): Set<string> {
  return new Set(Object.values(index.nodeIcons));
}

async function makeDerivative(input: string, output: string, width: number, quality: number): Promise<{ width: number; height: number; sizeBytes: number }> {
  await mkdir(path.dirname(output), { recursive: true });
  const image = sharp(input, { animated: false });
  const info = await image.metadata();
  if (!info.width || !info.height) throw new Error(`Missing dimensions for ${input}`);
  await image.resize({ width, withoutEnlargement: true }).webp({ quality, effort: 4 }).toFile(output);
  const outputInfo = await sharp(output).metadata();
  const outputStat = await stat(output);
  if (!outputInfo.width || !outputInfo.height) throw new Error(`Missing derivative dimensions for ${output}`);
  return { width: outputInfo.width, height: outputInfo.height, sizeBytes: outputStat.size };
}

function derivative(url: string, dimensions: { width: number; height: number; sizeBytes: number }): { url: string; width: number; height: number; mime: "image/webp"; sizeBytes: number } {
  return { url, ...dimensions, mime: "image/webp" };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const argument = (name: string, fallback: string): string => {
    const index = args.indexOf(name);
    return index >= 0 && args[index + 1] ? args[index + 1]! : fallback;
  };
  const packageRoot = path.resolve(argument("--package-root", "temp/arcaea-story-atlas-investigation/package"));
  const indexPath = path.resolve(argument("--index", "docs/apk-audit/data/arcaea-story-index.json"));
  const catalogPath = path.resolve(argument("--catalog", "catalog/index.json"));
  const outputRoot = path.resolve(argument("--output-root", "apps/site/public/generated/arcaea/story"));
  const manifestPath = path.resolve(argument("--manifest", "docs/apk-audit/data/arcaea-story-derivative-manifest.json"));
  const catalogValidation = validateCatalog(JSON.parse(await readFile(catalogPath, "utf8")) as unknown);
  if (!catalogValidation.success) throw new Error(`Catalog validation failed: ${catalogValidation.issues.slice(0, 3).map((issue) => issue.message).join("; ")}`);
  const catalog = catalogValidation.data;
  const storyIndex = JSON.parse(await readFile(indexPath, "utf8")) as StoryIndex;
  const storyResources = catalog.resources.filter((resource) => resource.game === "arcaea" && resource.lifecycle.status === "published" && (resource.resourceType === "story-cg" || resource.metadata.storyVisualKind === "vn-cg"));
  const uiCandidates = new Map<string, Resource>();
  for (const resource of catalog.resources) {
    const key = currentStoryUi(resource);
    if (!key) continue;
    const previous = uiCandidates.get(key);
    if (!previous || resource.provenance.some((item) => normalize(item.sourceRelativePath).includes("Arcaea/current-apk/"))) uiCandidates.set(key, resource);
  }
  for (const icon of usedNodeIcons(storyIndex)) {
    if (!uiCandidates.has(icon.endsWith(".png") ? icon : `${icon}.png`)) throw new Error(`Story node icon is not in the curated UI resource set: ${icon}`);
  }
  const avatarIds = usedCharacterIds(storyIndex);
  const avatarCandidates = catalog.resources.filter((resource) => resource.game === "arcaea" && resource.resourceType === "character-avatar" && resource.lifecycle.status === "published" && resourcePath(resource) && [...avatarIds].some((id) => resourcePath(resource)?.endsWith(`/char/${id}_icon.png`)));
  const ui: Record<string, ReturnType<typeof derivative>> = {};
  const avatars: Record<string, ReturnType<typeof derivative>> = {};
  const resources: Record<string, { thumb: ReturnType<typeof derivative>; preview: ReturnType<typeof derivative> }> = {};
  const missing: string[] = [];
  const budgetViolations: string[] = [];
  const make = async (resource: Resource, output: string, url: string, width: number, quality: number, budget: number): Promise<ReturnType<typeof derivative> | undefined> => {
    const input = await sourceFile(packageRoot, resource);
    if (!input) {
      missing.push(resource.id);
      return undefined;
    }
    const dimensions = await makeDerivative(input, output, width, quality);
    if (dimensions.sizeBytes > budget) budgetViolations.push(`${url} (${dimensions.sizeBytes} > ${budget})`);
    return derivative(url, dimensions);
  };

  for (const [key, resource] of [...uiCandidates.entries()].sort(([left], [right]) => left.localeCompare(right, "en"))) {
    const url = `/generated/arcaea/story/ui/${key.replace(/\.[^.]+$/u, ".webp")}`;
    const result = await make(resource, path.join(outputRoot, "ui", key.replace(/\.[^.]+$/u, ".webp")), url, key === "act-bg.jpg" ? 1800 : 1200, 78, key === "act-bg.jpg" ? 700_000 : 250_000);
    if (result) ui[key] = result;
  }
  for (const resource of avatarCandidates.sort((left, right) => left.id.localeCompare(right.id, "en"))) {
    const url = `/generated/arcaea/story/avatars/${resource.id}.webp`;
    const result = await make(resource, path.join(outputRoot, "avatars", `${resource.id}.webp`), url, 180, 80, 100_000);
    if (result) avatars[resource.id] = result;
  }
  for (const resource of storyResources.sort((left, right) => left.id.localeCompare(right.id, "en"))) {
    const thumbUrl = `/generated/arcaea/story/cg/thumb/${resource.id}.webp`;
    const previewUrl = `/generated/arcaea/story/cg/preview/${resource.id}.webp`;
    const thumb = await make(resource, path.join(outputRoot, "cg", "thumb", `${resource.id}.webp`), thumbUrl, 420, 78, 150_000);
    const preview = await make(resource, path.join(outputRoot, "cg", "preview", `${resource.id}.webp`), previewUrl, 1200, 82, 300_000);
    if (thumb && preview) resources[resource.id] = { thumb, preview };
  }
  if (missing.length > 0) throw new Error(`Missing bounded Story derivative sources: ${missing.join(", ")}`);
  const manifest = ArcaeaStoryDerivatives.parse({ manifestVersion: 1, source: storyIndex.source, ui, avatars, resources });
  await mkdir(path.dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await mkdir(outputRoot, { recursive: true });
  await writeFile(path.join(outputRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ ui: Object.keys(ui).length, avatars: Object.keys(avatars).length, resources: Object.keys(resources).length, budgetViolations }, null, 2));
}

if (process.argv[1]?.endsWith("arcaea-story-derivatives.ts")) await main();
