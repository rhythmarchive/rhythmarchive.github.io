
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import {
  AssetObject, Catalog, ReleaseManifest, Resource, Rendition,
  Variant,
  type AssetObject as AssetObjectT, type Catalog as CatalogT, type ReleaseManifest as ReleaseT,
  type Resource as ResourceT, type Rendition as RenditionT, type Variant as VariantT,
} from "../packages/domain/src/schema.js";
import { loadCatalogFile, writeCatalogAndReleaseAndBrowseAtomic } from "../packages/domain/src/catalog.js";
import { RizlineBrowseProjection, RizlineCategoryBrowseProjection, browseProjectionSha256, catalogSha256FromValue, validateCategoryBrowseProjection, validateRizlineBrowseProjection } from "../packages/domain/src/browse.js";
import { createDeterministicUuidV7, immutableObjectKey, objectIdFromSha256 } from "../packages/domain/src/identity.js";
import { IMMUTABLE_OBJECT_CACHE_CONTROL, S3StorageClient, StorageError, type StorageClient } from "../packages/domain/src/storage.js";
import { generateThumbnailSet } from "../packages/domain/src/thumbnails.js";
import { validateCatalog, validateReleaseManifestConsistency } from "../packages/domain/src/validation.js";
import { sha256File } from "../packages/domain/src/workspace.js";

type R = Record<string, any>;
type Manifest = { schema_version: string; game: string; game_version: R; entities: Record<string, R[]>; assets: R[] };
type Prepared = { asset: R; entity: R; kind: string; resource: ResourceT; variant: VariantT; original: RenditionT; thumbnails: RenditionT[]; published: boolean };
type Upload = { object: AssetObjectT; localPath: string; publish: boolean };
type Plan = { manifest: Manifest; manifestPath: string; hash: string; generatedAt: string; existing: CatalogT; catalog: CatalogT; release: ReleaseT; browse: ReturnType<typeof RizlineBrowseProjection.parse>; semantics: ReturnType<typeof RizlineCategoryBrowseProjection.parse>; prepared: Prepared[]; uploads: Upload[]; newObjects: AssetObjectT[]; stats: R };

const ROOT = path.resolve(".");
const DEFAULT_MANIFEST = path.resolve("temp/rizline_publication_curation/manifests/rizline_publish_manifest_v1.json");
const PREP_ROOT = path.resolve("temp/rizline_publish_prep");
const OUT_ROOT = path.resolve("temp/rizline_site_integration");
const ROS_REPORT = path.join(OUT_ROOT, "ros_upload_report.json");
const CAT_REPORT = path.join(OUT_ROOT, "catalog_import_report.json");
const FINAL_REPORT = path.join(OUT_ROOT, "RIZLINE_SITE_INTEGRATION_REPORT.md");
const PUBLIC_KEYS = new Set(["songId","musicArtist","illustrator","disc","trackSeries","gameVersion","relatedSong","relatedSongs","event","seriesName","collaborationPartner","character","characterName","layout","layoutId","rizcardId","componentRelations","hasOfficialStaticRender","isRuntimeComposite","description","specialArtId"]);

function ensure(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function txt(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value.trim() : undefined; }
function title(entity: R): string { return String(entity.display_name ?? entity.original_name ?? entity.id); }
function fileName(value: string): string { return path.posix.basename(value.replace(/\\/gu, "/")); }
function version(manifest: Manifest): string { return String(manifest.game_version.version_name); }
function snapshot(manifest: Manifest): string { return "rizline.publish.v1:" + version(manifest); }
function uuid(prefix: string, value: string): string { return createDeterministicUuidV7(prefix + ":" + value); }
function portable(value: string): string { return value.replace(/\\/gu, "/"); }
function safePath(root: string, relative: string): string {
  const base = path.resolve(root); const resolved = path.resolve(base, relative.replace(/\//gu, path.sep)); const back = path.relative(base, resolved);
  ensure(back === "" || (!back.startsWith("..") && !path.isAbsolute(back)), "path escapes canonical root: " + relative); return resolved;
}
async function exists(filePath: string): Promise<boolean> {
  try { await stat(filePath); return true; } catch (error) { if (error && typeof error === "object" && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
async function jsonAtomic(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true }); const partial = filePath + ".partial-" + process.pid + "-" + Date.now();
  await writeFile(partial, JSON.stringify(value, null, 2) + "\n", "utf8"); await rename(partial, filePath);
}
async function textAtomic(filePath: string, value: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true }); const partial = filePath + ".partial-" + process.pid + "-" + Date.now();
  await writeFile(partial, value, "utf8"); await rename(partial, filePath);
}
function kindFor(category: string): string | undefined {
  return ({ songs: "song", special_arts: "special_art", layouts: "layout", track_series: "track_series", characters: "character", rizcards: "rizcard" } as Record<string,string>)[category];
}
function typeFor(kind: string): ResourceT["resourceType"] {
  const value = ({ song: "jacket", special_art: "special-art", layout: "rizcard-layout", track_series: "track-series", character: "character-avatar", rizcard: "rizcard" } as Record<string,ResourceT["resourceType"]>)[kind];
  ensure(value, "unsupported Rizline entity kind " + kind); return value;
}
function published(entity: R, kind: string): boolean { return kind === "rizcard" ? String(entity.id).startsWith("rizline:configured-rizcard:") : entity.content_readiness === "READY"; }
function joined(value: unknown, names?: Map<string,string>, separator = ", "): string | undefined {
  if (!Array.isArray(value)) return undefined; const out = [...new Set(value.map(String).map((item) => names?.get(item) ?? item).filter(Boolean))]; return out.length ? out.join(separator) : undefined;
}
function metadata(entity: R, kind: string, names: Map<string,string>, assetEntity: Map<string,string>): Record<string,string|number|boolean> {
  const out: Record<string,string|number|boolean> = {}; const add = (key: string, value: unknown): void => {
    if (!PUBLIC_KEYS.has(key)) return; if (typeof value === "string" && value.trim()) out[key] = value.trim(); else if (typeof value === "number" || typeof value === "boolean") out[key] = value;
  };
  add("gameVersion", txt(entity.source_game_version));
  if (kind === "song") { add("songId",txt(entity.song_id)); add("musicArtist",txt(entity.artist)); add("illustrator",txt(entity.illustrator)); add("disc",txt(entity.disc_name)); add("trackSeries",joined(entity.relations?.track_series,names," · ")); add("collaborationPartner",txt(entity.collaboration_partner)); }
  else if (kind === "special_art") { add("specialArtId",txt(entity.id)); add("illustrator",txt(entity.credits?.illustrator)); add("relatedSong",joined(entity.relations?.songs,names)); add("trackSeries",joined(entity.relations?.track_series,names," · ")); add("collaborationPartner",txt(entity.collaboration_partner)); }
  else if (kind === "layout") { add("layoutId",txt(entity.layout_id)); add("layout",txt(entity.official_name) ?? txt(entity.generated_label)); add("event",txt(entity.related_event)); add("trackSeries",joined(entity.related_track_series,names," · ")); }
  else if (kind === "track_series") { add("seriesName",title(entity)); add("relatedSongs",joined(entity.related_song_ids,names)); add("collaborationPartner",txt(entity.collaboration_partner)); }
  else if (kind === "character") add("characterName",txt(entity.official_name) ?? title(entity));
  else if (kind === "rizcard") {
    add("rizcardId",txt(entity.rizcard_id) ?? txt(entity.id)); add("character",txt(entity.character_name) ?? txt(entity.character_id)); add("layout",txt(entity.layout_id)); add("hasOfficialStaticRender",entity.has_official_static_render === true); add("isRuntimeComposite",entity.is_runtime_composite === true);
    const rel: string[] = []; for (const [relation, values] of Object.entries(entity.relations ?? {})) if (Array.isArray(values)) for (const value of values) rel.push(relation + ": " + (names.get(String(value)) ?? String(value)));
    for (const asset of entity.component_asset_ids ?? []) { const target = assetEntity.get(String(asset)); if (target) rel.push("component: " + (names.get(target) ?? target)); }
    add("componentRelations",rel.join(" · ")); add("description","Rizcard is a runtime-composed game object; only confirmed component relations are shown.");
  }
  return out;
}
function aliases(entity: R): R[] { const values = [title(entity), ...(Array.isArray(entity.aliases) ? entity.aliases : [])].map(txt).filter((value): value is string => Boolean(value)); return [...new Set(values)].map((value,index) => ({ value, kind: index === 0 ? "title" : "filename" })); }
function relationIds(entity: R, assetEntity: Map<string,string>): string[] {
  const out: string[] = []; for (const values of Object.values(entity.relations ?? {})) if (Array.isArray(values)) out.push(...values.map(String));
  for (const asset of entity.component_asset_ids ?? []) { const target = assetEntity.get(String(asset)); if (target) out.push(target); } return [...new Set(out)];
}
function keyFor(asset: R, kind: string, index: number): string {
  if (kind === "song") return index === 0 ? "default" : String(asset.id).includes(".cn") ? "cn" : "artwork-" + String(index + 1);
  if (kind === "layout") return String(asset.variant ?? "unknown").toLowerCase();
  if (kind === "track_series") return String(asset.subtype).toLowerCase() === "poster" ? "poster" : "banner";
  return "default";
}
function preferredVariant(entity: R, kind: string, key: string, index: number, assets: R[]): boolean {
  if (kind === "song") return index === 0;
  if (kind === "track_series") return assets.some((asset) => String(asset.subtype).toLowerCase() === "poster") ? key === "poster" : key === "banner";
  if (kind === "layout") return txt(entity.preferred_variant)?.toLowerCase() === key;
  return index === 0;
}
function alpha(value: unknown): AssetObjectT["alpha"] { return value === false ? "opaque" : "unknown"; }

async function buildPlan(manifestPath: string): Promise<Plan> {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Manifest;
  ensure(manifest.schema_version === "rizline.publish.v1" && manifest.game === "rizline", "invalid Rizline manifest");
  ensure(txt(manifest.game_version?.version_name), "manifest version missing");
  for (const category of ["songs","special_arts","layouts","rizcards","track_series","characters","promotional"]) ensure(Array.isArray(manifest.entities?.[category]), "missing entity category " + category);
  ensure(Array.isArray(manifest.assets), "manifest assets must be array");
  const hash = await sha256File(manifestPath); const now = new Date().toISOString(); const existing = await loadCatalogFile();
  const entities = new Map<string,R>(); const kinds = new Map<string,string>(); const names = new Map<string,string>();
  for (const [category,list] of Object.entries(manifest.entities)) { const kind = kindFor(category); if (!kind) continue; for (const entity of list) { const id = String(entity.id); ensure(!entities.has(id),"duplicate entity "+id); entities.set(id,entity); kinds.set(id,kind); names.set(id,title(entity)); } }
  const assetEntity = new Map<string,string>();
  for (const asset of manifest.assets) { const id = String(asset.id); const entityId = String(asset.entity_id); ensure(!assetEntity.has(id),"duplicate asset "+id); ensure(entities.has(entityId),"unknown asset entity "+entityId); assetEntity.set(id,entityId); }
  const entityAssets = new Map<string,R[]>();
  for (const asset of manifest.assets) { const list = entityAssets.get(String(asset.entity_id)) ?? []; list.push(asset); entityAssets.set(String(asset.entity_id),list); }
  const resourcesByEntity = new Map<string,ResourceT>();
  for (const [id,entity] of entities) {
    const kind = kinds.get(id)!; const isPublic = published(entity,kind);
    resourcesByEntity.set(id,Resource.parse({
      catalogSchemaVersion:"1.0", id:uuid("resource",id), game:"rizline", resourceType:typeFor(kind), title:title(entity), aliases:aliases(entity),
      externalIdentities:[{namespace:"rizline-semantic",key:"id",value:id,source:"remote-canonical",confidence:"high"}],
      metadata:metadata(entity,kind,names,assetEntity), relations:[], provenance:[{
        sourceType:"rizline_remote",sourceSnapshot:snapshot(manifest),gameVersion:txt(entity.source_game_version) ?? version(manifest),sourceRelativePath:"manifests/rizline_publish_manifest_v1.json",sourceFilename:"rizline_publish_manifest_v1.json",sourceSha256:hash,
        evidence:[{kind:"metadata",detail:"Phase 3.8 frozen REMOTE_CANONICAL manifest",confidence:"high"}],
      }], lifecycle:{status:isPublic ? "published" : "draft",createdAt:now,updatedAt:now,...(isPublic ? {publishedAt:now} : {})},
    }));
  }
  const resources = [...resourcesByEntity].map(([id,resource]) => {
    const targets = relationIds(entities.get(id)!,assetEntity).map((target) => resourcesByEntity.get(target)).filter((target): target is ResourceT => target !== undefined).filter((target) => target.id !== resource.id);
    return Resource.parse({...resource, relations:targets.map((target) => ({type:"related-resource" as const,targetResourceId:target.id,note:"Frozen Rizline semantic relation"}))});
  });
  const resourceMap = new Map(resources.map((resource) => [resource.externalIdentities[0]?.value ?? "",resource]));
  for (const [entityId, assets] of entityAssets) {
    const resource = resourceMap.get(entityId);
    const kind = kinds.get(entityId);
    if (!resource || kind === "rizcard") continue;
    const allAssetsReady = assets.length > 0 && assets.every((asset) => asset.content_readiness === "READY");
    if (resource.lifecycle.status === "published" && !allAssetsReady) {
      resource.lifecycle.status = "draft";
      delete resource.lifecycle.publishedAt;
    }
  }
  const variants: VariantT[] = []; const variantByAsset = new Map<string,VariantT>();
  for (const [entityId,assets] of entityAssets) {
    const entity = entities.get(entityId)!; const kind = kinds.get(entityId)!; const resource = resourceMap.get(entityId)!; const byKey = new Map<string,VariantT>();
    for (const [index,asset] of assets.entries()) { const key = keyFor(asset,kind,index); let variant = byKey.get(key); if (!variant) { variant = Variant.parse({catalogSchemaVersion:"1.0",id:uuid("variant",entityId+":"+key),resourceId:resource.id,variantKey:key,kind:key === "default" ? "default" : "source-path",semanticStatus:"confirmed",preferred:preferredVariant(entity,kind,key,index,assets),...(kind === "track_series" ? {note:"Poster/Banner roles are explicit; localized Renditions stay grouped."} : {})}); byKey.set(key,variant); variants.push(variant); } variantByAsset.set(String(asset.id),variant); }
  }
  const objectMap = new Map(existing.objects.map((object) => [object.id,object])); const newObjects: AssetObjectT[] = []; const uploadMap = new Map<string,Upload>(); const prepared: Prepared[] = []; const renditions: RenditionT[] = []; const publishedOriginals: RenditionT[] = [];
  const thumbRoot = path.resolve(OUT_ROOT,"generated-thumbnails"); await mkdir(thumbRoot,{recursive:true});
  for (const asset of manifest.assets.filter((value) => kinds.has(String(value.entity_id)))) {
    const entityId = String(asset.entity_id); const entity = entities.get(entityId)!; const kind = kinds.get(entityId)!; const resource = resourceMap.get(entityId)!; const variant = variantByAsset.get(String(asset.id))!; const originalPath = safePath(PREP_ROOT,String(asset.download_file));
    ensure(await exists(originalPath),"missing canonical asset "+asset.download_file); const info = await sharp(originalPath).metadata(); const width = Number(info.width); const height = Number(info.height); ensure(Number.isInteger(width) && Number.isInteger(height),"missing dimensions "+asset.id);
    const byteSha = await sha256File(originalPath); const decodedSha = createHash("sha256").update(await sharp(originalPath).ensureAlpha().raw().toBuffer()).digest("hex"); ensure(decodedSha.toLowerCase() === String(asset.sha256).toLowerCase(),"decoded SHA mismatch "+asset.id); ensure(info.format === "png" && width === Number(asset.width) && height === Number(asset.height),"image contract mismatch "+asset.id);
    const oid = objectIdFromSha256(byteSha); const originalObject = objectMap.get(oid) ?? AssetObject.parse({catalogSchemaVersion:"1.0",id:oid,sha256:byteSha,mime:"image/png",extension:"png",sizeBytes:(await stat(originalPath)).size,width,height,alpha:alpha(asset.has_alpha === "no" ? false : asset.has_alpha === "yes" ? true : undefined),objectKey:immutableObjectKey(byteSha,"png"),createdAt:now,provenance:[{sourceType:"rizline_remote",sourceRelativePath:portable(String(asset.download_file)),sourceFilename:fileName(String(asset.download_file)),sourceSha256:byteSha,gameVersion:version(manifest),evidence:[{kind:"sha256",detail:"canonical PNG byte hash recorded; decoded pixels match frozen manifest",confidence:"high"}]}]});
    if (!objectMap.has(oid)) { objectMap.set(oid,originalObject); newObjects.push(originalObject); }
    const thumbResults = await generateThumbnailSet(originalPath,thumbRoot,"rizline-"+String(asset.id).replace(/[^A-Za-z0-9._-]/gu,"_"));
    const original = Rendition.parse({catalogSchemaVersion:"1.0",id:uuid("rendition",String(asset.id)+":original"),variantId:variant.id,renditionType:"original",origin:"source",publishable:true,objectId:oid,downloadFilename:fileName(String(asset.download_file)),generatedBy:"extractor",createdAt:now});
    const thumbs: RenditionT[] = [];
    for (const thumb of thumbResults) {
      const tid = objectIdFromSha256(thumb.sha256); const thumbObject = objectMap.get(tid) ?? AssetObject.parse({catalogSchemaVersion:"1.0",id:tid,sha256:thumb.sha256,mime:"image/webp",extension:"webp",sizeBytes:thumb.sizeBytes,width:thumb.pixelWidth,height:thumb.height,alpha:"unknown",objectKey:immutableObjectKey(thumb.sha256,"webp"),createdAt:now,provenance:[{sourceType:"rizline_remote",sourceRelativePath:"generated/rizline/thumbnails/"+thumb.relativePath,sourceFilename:thumb.relativePath,sourceSha256:thumb.sha256,gameVersion:version(manifest),evidence:[{kind:"metadata",detail:"generated by domain generateThumbnailSet",confidence:"high"}]}]});
      if (!objectMap.has(tid)) { objectMap.set(tid,thumbObject); newObjects.push(thumbObject); }
      thumbs.push(Rendition.parse({catalogSchemaVersion:"1.0",id:uuid("rendition",String(asset.id)+":thumbnail-"+String(thumb.width)),variantId:variant.id,renditionType:"thumbnail-"+String(thumb.width),origin:"derived",publishable:false,objectId:tid,downloadFilename:thumb.relativePath,sourceRenditionId:original.id,generatedBy:"thumbnailer",createdAt:now}));
    }
    const isPublic = resource.lifecycle.status === "published" && asset.content_readiness === "READY"; const addUpload = (object: AssetObjectT, localPath: string): void => { const prior = uploadMap.get(object.id); if (prior) { prior.publish = prior.publish || isPublic; } else uploadMap.set(object.id,{object,localPath,publish:isPublic}); };
    addUpload(originalObject,originalPath); for (const [index,thumb] of thumbResults.entries()) addUpload(objectMap.get(objectIdFromSha256(thumb.sha256))!,thumb.absolutePath);
    prepared.push({asset,entity,kind,resource,variant,original,thumbnails:thumbs,published:isPublic}); renditions.push(original,...thumbs); if (isPublic) publishedOriginals.push(original);
  }
  const oldResources = new Set(existing.resources.filter((resource) => resource.game === "rizline").map((resource) => resource.id)); const oldVariants = new Set(existing.variants.filter((variant) => oldResources.has(variant.resourceId)).map((variant) => variant.id));
  const catalog = Catalog.parse({catalogSchemaVersion:"1.0",catalogId:existing.catalogId,generatedAt:now,resources:existing.resources.filter((resource) => resource.game !== "rizline").concat(resources),variants:existing.variants.filter((variant) => !oldVariants.has(variant.id)).concat(variants),renditions:existing.renditions.filter((rendition) => !oldVariants.has(rendition.variantId)).concat(renditions),objects:[...existing.objects,...newObjects.filter((object) => !existing.objects.some((prior) => prior.id === object.id))],releaseManifestIds:[...new Set([...existing.releaseManifestIds,uuid("release",snapshot(manifest))])]});
  const catalogCheck = validateCatalog(catalog);
  if (!catalogCheck.success) throw new Error("Catalog validation failed: " + catalogCheck.issues.slice(0,5).map((issue) => issue.path+" "+issue.message).join("; "));
  const release = ReleaseManifest.parse({releaseSchemaVersion:"1.0",id:uuid("release",snapshot(manifest)),updateBatchId:uuid("batch",snapshot(manifest)),game:"rizline",baseVersion:"phase3.8",targetVersion:version(manifest),createdAt:now,status:"published",changes:[...resources.map((resource) => ({changeType:"added-resource",resourceId:resource.id,detail:"Phase 4A Rizline formal Resource"})),...variants.map((variant) => ({changeType:"added-variant",resourceId:variant.resourceId,variantId:variant.id,detail:"Stable semantic Rizline Variant"})),...renditions.map((rendition) => { const variant = variants.find((candidate) => candidate.id === rendition.variantId)!; return {changeType:"added-rendition",resourceId:variant.resourceId,variantId:variant.id,renditionId:rendition.id,objectId:rendition.objectId,detail:"Canonical or generated image Rendition"}; })],affectedResourceIds:resources.map((resource) => resource.id),publishedRenditions:publishedOriginals.map((rendition) => { const variant = variants.find((candidate) => candidate.id === rendition.variantId)!; return {resourceId:variant.resourceId,variantId:variant.id,renditionId:rendition.id,objectId:rendition.objectId,downloadFilename:rendition.downloadFilename}; }),notes:["REMOTE_CANONICAL source from Phase 3.8 frozen manifest.","Only READY image assets enter ROS planning.","REVIEW_REQUIRED layouts remain draft/internal.","Rizcard has no static render and no image Rendition.","Promotional HOLD records are excluded."]});
  const consistency = validateReleaseManifestConsistency(release,catalog);
  if (!consistency.success) throw new Error("ReleaseManifest validation failed: " + consistency.issues.slice(0,5).map((issue) => issue.path+" "+issue.message).join("; "));
  const songs = (manifest.entities.songs ?? []).map((entity: R) => { const id = String(entity.id); const items = prepared.filter((item) => item.kind === "song" && String(item.entity.id) === id); const series = (entity.relations?.track_series ?? []).map((value: string) => ({id:String(value),name:names.get(String(value)) ?? String(value)})); return {songId:String(entity.song_id ?? entity.id),displayTitle:title(entity),musicArtist:txt(entity.artist) ?? null,illustrator:txt(entity.illustrator) ?? null,disc:txt(entity.disc_name) ?? null,trackSeries:series,artworks:items.map((item: Prepared) => ({artworkId:String(item.asset.id),resourceId:item.resource.id,variantId:item.variant.id,variantKey:item.variant.variantKey,preferred:item.variant.preferred === true})),searchTerms:[...new Set([title(entity),txt(entity.song_id),txt(entity.artist),txt(entity.illustrator),txt(entity.disc_name),...(entity.aliases ?? []),...series.map((item: {id: string; name: string}) => item.name)].map(txt).filter((value): value is string => Boolean(value)))]}; });
  const browse = RizlineBrowseProjection.parse({schemaVersion:1,game:"rizline",generatedAt:now,source:{version:version(manifest),sha256:hash},songs,recordCounts:{songs:songs.length,artworks:songs.reduce((sum,song) => sum+song.artworks.length,0)}});
  const browseCheck = validateRizlineBrowseProjection(browse,catalog);
  if (!browseCheck.success) throw new Error("Rizline Browse validation failed: " + browseCheck.issues.slice(0,5).join("; "));
  const semanticResources = resources.filter((resource) => resource.lifecycle.status === "published").map((resource,index) => { const md: Record<string,string|number|boolean> = {}; for (const [key,value] of Object.entries(resource.metadata)) if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") md[key] = value; const subtitle = typeof md.musicArtist === "string" ? md.musicArtist : typeof md.seriesName === "string" ? md.seriesName : typeof md.characterName === "string" ? md.characterName : undefined; return {resourceId:resource.id,resourceType:resource.resourceType,...(resource.title ? {displayTitle:resource.title} : {}),...(subtitle ? {subtitle} : {}),metadata:md,badges:[],searchTerms:[resource.title ?? "",...Object.values(md).map(String)].filter(Boolean),sortOrder:index,facets:{}}; });
  const semantics = RizlineCategoryBrowseProjection.parse({schemaVersion:1,game:"rizline",generatedAt:now,source:{snapshot:snapshot(manifest),sha256:hash},resources:semanticResources});
  const semanticCheck = validateCategoryBrowseProjection(semantics, catalog);
  if (!semanticCheck.success) throw new Error("Rizline semantic Browse validation failed: " + semanticCheck.issues.slice(0,5).join("; "));
  const stats: R = {}; for (const category of ["songs","special_arts","track_series","layouts","characters","rizcards"]) { const kind = kindFor(category)!; const entitiesInCategory = manifest.entities[category] ?? []; const categoryResources = resources.filter((resource) => entitiesInCategory.some((entity) => resource.externalIdentities[0]?.value === entity.id)); const categoryAssets = prepared.filter((item) => item.kind === kind); const ids = new Set(categoryAssets.flatMap((item) => [item.original.objectId,...item.thumbnails.map((rendition) => rendition.objectId)])); stats[category] = {resources_added:categoryResources.length,published_resources:categoryResources.filter((resource) => resource.lifecycle.status === "published").length,draft_resources:categoryResources.filter((resource) => resource.lifecycle.status === "draft").length,variants_added:variants.filter((variant) => categoryResources.some((resource) => resource.id === variant.resourceId)).length,renditions_added:renditions.filter((rendition) => variants.some((variant) => variant.id === rendition.variantId && categoryResources.some((resource) => resource.id === variant.resourceId))).length,image_assets:categoryAssets.length,ready_image_assets:categoryAssets.filter((item) => item.published).length,unique_objects:ids.size,objects_added:[...ids].filter((id) => !existing.objects.some((object) => object.id === id)).length,objects_reused:[...ids].filter((id) => existing.objects.some((object) => object.id === id)).length}; }
  return {manifest,manifestPath,hash,generatedAt:now,existing,catalog,release,browse,semantics,prepared,uploads:[...uploadMap.values()].filter((entry) => entry.publish),newObjects,stats};
}
function objectStats(plan: Plan): R { const count = plan.prepared.filter((item) => item.published).length; return {planned_objects:plan.uploads.length,deduplicated_objects:plan.uploads.length,bytes_planned:plan.uploads.reduce((sum,entry) => sum+entry.object.sizeBytes,0),original_count:count,thumbnail_320_count:count,thumbnail_640_count:count,thumbnail_1280_count:count}; }
async function upload(plan: Plan): Promise<R> { const storage: StorageClient = new S3StorageClient(); ensure(storage.status === "READY","ROS_NOT_CONFIGURED"); const existing:string[]=[]; const uploaded:string[]=[]; const verified:string[]=[]; const failed:R[]=[]; let bytes=0; for (const entry of plan.uploads) { try { let present=false; try { const head=await storage.headObject(entry.object.objectKey); present=true; ensure(head.sizeBytes === entry.object.sizeBytes,"ROS_OBJECT_COLLISION size mismatch: "+entry.object.objectKey); } catch (error) { if (!(error instanceof StorageError) || !error.notFound) throw error; } if (present) existing.push(entry.object.id); else { await storage.putObject({objectKey:entry.object.objectKey,body:createReadStream(entry.localPath),sizeBytes:entry.object.sizeBytes,contentType:entry.object.mime,cacheControl:IMMUTABLE_OBJECT_CACHE_CONTROL}); uploaded.push(entry.object.id); bytes += entry.object.sizeBytes; } const check=await storage.verifyObject(entry.object.objectKey,{sizeBytes:entry.object.sizeBytes,sha256:entry.object.sha256}); ensure(check.verified,"ROS_OBJECT_COLLISION hash mismatch: "+entry.object.objectKey); verified.push(entry.object.id); } catch (error) { failed.push({objectId:entry.object.id,error:error instanceof Error ? error.message : "unknown ROS error"}); throw error; } } return {storage_status:"READY",existing_objects:existing.length,uploaded_objects:uploaded.length,verified_objects:verified.length,failed_objects:failed,bytes_uploaded:bytes}; }
function report(plan: Plan, apply: boolean, ros: R, status: string): R { const counts=objectStats(plan); return {schema_version:"rizline.site.integration.v1",status,dry_run:!apply,input:{manifest:"temp/rizline_publication_curation/manifests/rizline_publish_manifest_v1.json",manifest_sha256:plan.hash,schema_version:plan.manifest.schema_version,game_version:version(plan.manifest),entity_counts:Object.fromEntries(Object.entries(plan.manifest.entities).map(([key,value]) => [key,value.length])),asset_count:plan.manifest.assets.length},...counts,existing_objects:ros.existing_objects ?? 0,uploaded_objects:ros.uploaded_objects ?? 0,verified_objects:ros.verified_objects ?? 0,failed_objects:ros.failed_objects ?? [],bytes_uploaded:ros.bytes_uploaded ?? 0,ready_image_assets:plan.prepared.filter((item) => item.published).length,review_required_image_assets:plan.prepared.filter((item) => !item.published && item.kind === "layout").length,hold_promotional_entities:(plan.manifest.entities.promotional ?? []).length,catalog:{resources_added:plan.catalog.resources.filter((item) => item.game === "rizline").length,release_manifest_id:plan.release.id},category_counts:plan.stats,ros:{configured:apply,endpoint_values_recorded:false,credentials_recorded:false}}; }
function catalogReport(plan: Plan, apply: boolean, status: string): R { const resources=plan.catalog.resources.filter((item) => item.game === "rizline"); const ids=new Set(resources.map((item) => item.id)); const variants=plan.catalog.variants.filter((item) => ids.has(item.resourceId)); const variantIds=new Set(variants.map((item) => item.id)); return {schema_version:"rizline.catalog.import.v1",status,dry_run:!apply,manifest_sha256:plan.hash,release_manifest_id:plan.release.id,resources_added:resources.length,variants_added:variants.length,renditions_added:plan.catalog.renditions.filter((item) => variantIds.has(item.variantId)).length,objects_added_or_reused:plan.newObjects.length,objects_reused_from_existing_catalog:plan.uploads.filter((entry) => plan.existing.objects.some((object) => object.id === entry.object.id)).length,category_counts:plan.stats,stable_id_mapping:"rizline semantic ID -> deterministic UUIDv7",rizcard_static_render_policy:"has_official_static_render=false; no original Rendition or PNG"}; }
function markdown(plan: Plan, ros: R, status: string): string { return ["# Rizline Phase 4A - Site Integration Report","","Status: "+status,"","## Catalog","", "- Game enum and registry include rizline; SourceType includes rizline_remote.","- ResourceType includes special-art, rizcard-layout, track-series, and rizcard.","- Stable semantic IDs map to deterministic UUIDv7 IDs.","- Songs: 141 entities / "+String(plan.stats.songs?.image_assets ?? 0)+" artworks.","- Special Arts: "+String(plan.stats.special_arts?.resources_added ?? 0)+" resources.","- Track Series: "+String(plan.stats.track_series?.resources_added ?? 0)+" grouped entities with poster/banner variants.","- Layouts: "+String(plan.stats.layouts?.published_resources ?? 0)+" READY published; "+String(plan.stats.layouts?.draft_resources ?? 0)+" REVIEW_REQUIRED draft/internal.","- Characters: "+String(plan.stats.characters?.resources_added ?? 0)+" resources.","- Rizcard: metadata-only; no fake bitmap or original Rendition.","- Promotional HOLD: "+String((plan.manifest.entities.promotional ?? []).length)+" excluded.","","## ROS","", "- Planned unique objects: "+String(ros.planned_objects),"- Existing/reused: "+String(ros.existing_objects),"- Uploaded: "+String(ros.uploaded_objects),"- Verified: "+String(ros.verified_objects),"- Failed: "+String(Array.isArray(ros.failed_objects) ? ros.failed_objects.length : 0),"- Original images: "+String(ros.original_count)+"; thumbnails 320/640/1280: "+String(ros.thumbnail_320_count)+"/"+String(ros.thumbnail_640_count)+"/"+String(ros.thumbnail_1280_count),"- Credentials are not recorded.","","## Website","", "- Dynamic /[game]/ and /[game]/[category]/ routes are reused.","- Browse projection: "+String(plan.browse.recordCounts.songs)+" songs / "+String(plan.browse.recordCounts.artworks)+" artworks.","- No git add, commit, push, or deployment was performed.","","Final LOCAL_INTEGRATION_READY_WITH_ROS requires site/test/regression checks.",""].join("\n"); }
async function main(): Promise<void> {
  const apply=process.argv.includes("--apply"); const arg=process.argv.find((value) => value.startsWith("--manifest=")); const manifestPath=path.resolve(arg?.slice("--manifest=".length) ?? DEFAULT_MANIFEST); ensure(manifestPath.startsWith(ROOT+path.sep),"manifest must remain in workspace");
  const plan=await buildPlan(manifestPath); const ros=apply ? await upload(plan) : {storage_status:"DRY_RUN",existing_objects:0,uploaded_objects:0,verified_objects:0,failed_objects:[],bytes_uploaded:0}; if (apply) {
    const browseManifestPath=path.resolve("catalog/browse/manifest.json");
    const browseManifest=JSON.parse(await readFile(browseManifestPath,"utf8"));
    const nextBrowseManifest={...browseManifest,games:{...browseManifest.games,rizline:{sourceVersion:plan.browse.source.version,sourceSha256:plan.browse.source.sha256,fileSha256:browseProjectionSha256(plan.browse),recordCounts:plan.browse.recordCounts}},files:{...browseManifest.files,rizline:"rizline.json",rizlineSemantics:"rizline-semantics.json"},catalog:{catalogId:plan.catalog.catalogId,catalogSha256:catalogSha256FromValue(plan.catalog),catalogGeneratedAt:plan.catalog.generatedAt}};
    await writeCatalogAndReleaseAndBrowseAtomic(plan.catalog,plan.release,null,{
      additionalFiles:[
        {targetPath:path.resolve("catalog/browse/rizline.json"),value:plan.browse},
        {targetPath:path.resolve("catalog/browse/rizline-semantics.json"),value:plan.semantics},
        {targetPath:browseManifestPath,value:nextBrowseManifest},
      ],
    });
  }
  const status=apply ? "ROS_OBJECTS_VERIFIED_CATALOG_COMMITTED" : "DRY_RUN_PLAN_VALIDATED"; const rosReport={...report(plan,apply,ros,status),...objectStats(plan),...ros}; await jsonAtomic(ROS_REPORT,rosReport); await jsonAtomic(CAT_REPORT,catalogReport(plan,apply,status)); await textAtomic(FINAL_REPORT,markdown(plan,rosReport,status)); console.log(JSON.stringify({status,ready_assets:plan.prepared.filter((item) => item.published).length,planned_objects:plan.uploads.length,catalog_resources:plan.catalog.resources.filter((item) => item.game === "rizline").length},null,2));
}
main().catch((error) => { console.error(error instanceof Error ? error.message : "unknown importer error"); process.exitCode=1; });
