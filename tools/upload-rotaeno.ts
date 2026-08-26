import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  loadCatalogFile,
} from "../packages/domain/src/catalog.js";
import {
  immutableObjectKey,
} from "../packages/domain/src/identity.js";
import {
  IMMUTABLE_OBJECT_CACHE_CONTROL,
  S3StorageClient,
  StorageError,
  loadRosStorageConfig,
  rosStorageStatus,
  type StorageClient,
} from "../packages/domain/src/storage.js";
import type {
  AssetObject as AssetObjectType,
  Catalog as CatalogType,
  Rendition as RenditionType,
} from "../packages/domain/src/schema.js";

const ROOT = path.resolve(".");
const DEFAULT_PLAN = path.resolve("temp/rotaeno_publish/2.26.1-full-images-v2/rotaeno-import-plan.json");
const DEFAULT_REPORT = path.resolve("temp/rotaeno_publish/2.26.1-full-images-v2/rotaeno-ros-upload-report.json");
const TEMP_ROOT = path.resolve("temp");

type Args = {
  apply: boolean;
  verifyOnly: boolean;
  planPath: string;
  reportPath: string;
};

type ImportPlan = {
  status?: string;
  remoteWrite?: string;
  sourceSnapshot: string;
  sourceSha256: string;
  resourceCount: number;
  renditionCount: number;
  objectCount: number;
  releaseId: string;
};

type UploadEntry = {
  object: AssetObjectType;
  localPath: string;
  sourceRelativePath: string;
  renditionTypes: string[];
};

type LocalPlan = {
  catalog: CatalogType;
  importPlan: ImportPlan;
  resources: CatalogType["resources"];
  renditions: RenditionType[];
  entries: UploadEntry[];
  roleCounts: Record<string, number>;
  objectListSha256: string;
  localBytes: number;
};

type RemoteResult = {
  existingObjects: number;
  uploadedObjects: number;
  verifiedObjects: number;
  bytesUploaded: number;
};

function ensure(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function parseArgs(argv: string[]): Args {
  let planPath = DEFAULT_PLAN;
  let reportPath = DEFAULT_REPORT;
  let apply = false;
  let verifyOnly = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--apply") {
      apply = true;
      continue;
    }
    if (token === "--verify-only") {
      verifyOnly = true;
      continue;
    }
    if (token === "--plan" || token === "--report") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${token} requires a value`);
      if (token === "--plan") planPath = path.resolve(value);
      else reportPath = path.resolve(value);
      index += 1;
      continue;
    }
    throw new Error(`unexpected argument: ${token}`);
  }
  ensure(!(apply && verifyOnly), "--apply and --verify-only are mutually exclusive");
  ensure(planPath.startsWith(TEMP_ROOT + path.sep), "--plan must remain inside repository temp/");
  ensure(reportPath.startsWith(TEMP_ROOT + path.sep), "--report must remain inside repository temp/");
  return { apply, verifyOnly, planPath, reportPath };
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

function inside(root: string, candidate: string): boolean {
  const normalizedRoot = path.resolve(root).toLowerCase() + path.sep;
  return path.resolve(candidate).toLowerCase().startsWith(normalizedRoot);
}

function localPathFromObject(object: AssetObjectType): { localPath: string; sourceRelativePath: string } {
  const provenance = object.provenance.find((item) => item.sourceType === "rotaeno_apk" && Boolean(item.sourceRelativePath));
  ensure(provenance?.sourceRelativePath, `Rotaeno object has no local provenance: ${object.id}`);
  const sourceRelativePath = provenance.sourceRelativePath.replaceAll("\\", "/");
  ensure(!path.isAbsolute(sourceRelativePath), `Rotaeno provenance must be relative: ${object.id}`);
  const localPath = path.resolve(ROOT, sourceRelativePath);
  ensure(inside(TEMP_ROOT, localPath), `Rotaeno upload source must remain in temp/: ${object.id}`);
  return { localPath, sourceRelativePath };
}

async function readImportPlan(planPath: string): Promise<ImportPlan> {
  const value = JSON.parse(await readFile(planPath, "utf8")) as ImportPlan;
  ensure(value.sourceSnapshot.startsWith("rotaeno:mainland_cn:"), "Rotaeno import plan source snapshot is invalid");
  ensure(/^[0-9a-f]{64}$/u.test(value.sourceSha256), "Rotaeno import plan source SHA-256 is invalid");
  ensure(Number.isInteger(value.resourceCount) && Number.isInteger(value.renditionCount) && Number.isInteger(value.objectCount), "Rotaeno import plan counts are invalid");
  ensure(typeof value.releaseId === "string" && value.releaseId.length > 0, "Rotaeno import plan release ID is missing");
  return value;
}

async function buildLocalPlan(planPath: string): Promise<LocalPlan> {
  const catalog = await loadCatalogFile();
  const importPlan = await readImportPlan(planPath);
  const resources = catalog.resources.filter((resource) => resource.game === "rotaeno");
  ensure(resources.length === importPlan.resourceCount, `Rotaeno resource count mismatch: Catalog=${resources.length}, plan=${importPlan.resourceCount}`);
  ensure(catalog.releaseManifestIds.includes(importPlan.releaseId), "Rotaeno release ID is not present in Catalog");

  const resourceIds = new Set(resources.map((resource) => resource.id));
  const variantIds = new Set(catalog.variants.filter((variant) => resourceIds.has(variant.resourceId)).map((variant) => variant.id));
  const renditions = catalog.renditions.filter((rendition) => variantIds.has(rendition.variantId));
  ensure(renditions.length === importPlan.renditionCount, `Rotaeno rendition count mismatch: Catalog=${renditions.length}, plan=${importPlan.renditionCount}`);
  const roleCounts: Record<string, number> = {};
  for (const rendition of renditions) roleCounts[rendition.renditionType] = (roleCounts[rendition.renditionType] ?? 0) + 1;
  for (const role of ["original", "thumbnail-320", "thumbnail-640", "thumbnail-1280"]) ensure(roleCounts[role] === resources.length, `Rotaeno rendition role count mismatch: ${role}`);

  const objectsById = new Map(catalog.objects.map((object) => [object.id, object]));
  const entriesById = new Map<string, UploadEntry>();
  for (const rendition of renditions) {
    const object = objectsById.get(rendition.objectId);
    ensure(object, `Rotaeno rendition references missing object: ${rendition.objectId}`);
    const current = entriesById.get(object.id);
    if (current) {
      current.renditionTypes.push(rendition.renditionType);
      continue;
    }
    const local = localPathFromObject(object);
    entriesById.set(object.id, { object, localPath: local.localPath, sourceRelativePath: local.sourceRelativePath, renditionTypes: [rendition.renditionType] });
  }
  const entries = [...entriesById.values()].sort((left, right) => left.object.objectKey.localeCompare(right.object.objectKey));
  ensure(entries.length === importPlan.objectCount, `Rotaeno object count mismatch: Catalog=${entries.length}, plan=${importPlan.objectCount}`);

  let localBytes = 0;
  for (const entry of entries) {
    const expectedKey = immutableObjectKey(entry.object.sha256, entry.object.extension);
    ensure(entry.object.objectKey === expectedKey, `Rotaeno object key is not content-addressed: ${entry.object.id}`);
    ensure(entry.object.id === `sha256:${entry.object.sha256}`, `Rotaeno object ID/hash mismatch: ${entry.object.id}`);
    const info = await stat(entry.localPath);
    ensure(info.isFile(), `Rotaeno upload source is not a file: ${entry.sourceRelativePath}`);
    ensure(info.size === entry.object.sizeBytes, `Rotaeno local size mismatch: ${entry.object.objectKey}`);
    ensure((await sha256File(entry.localPath)) === entry.object.sha256, `Rotaeno local SHA-256 mismatch: ${entry.object.objectKey}`);
    localBytes += info.size;
  }
  const objectListSha256 = createHash("sha256").update(entries.map((entry) => `${entry.object.objectKey}\t${entry.object.sizeBytes}\t${entry.sourceRelativePath}`).join("\n"), "utf8").digest("hex");
  return { catalog, importPlan, resources, renditions, entries, roleCounts, objectListSha256, localBytes };
}

function safeError(error: unknown): string {
  if (error instanceof StorageError) return error.message;
  return error instanceof Error ? error.message : "unknown ROS error";
}

async function runRemote(localPlan: LocalPlan, args: Args): Promise<RemoteResult> {
  const storage: StorageClient = new S3StorageClient(loadRosStorageConfig());
  ensure(storage.status === "READY", "ROS credentials are not configured");
  const result: RemoteResult = { existingObjects: 0, uploadedObjects: 0, verifiedObjects: 0, bytesUploaded: 0 };
  const mode = args.verifyOnly ? "verify-only" : "upload";
  console.log(JSON.stringify({ status: "ROS_UPLOAD_BEGIN", mode, objects: localPlan.entries.length, renditions: localPlan.renditions.length, localBytes: localPlan.localBytes }));
  for (let index = 0; index < localPlan.entries.length; index += 1) {
    const entry = localPlan.entries[index]!;
    let present = false;
    try {
      const head = await storage.headObject(entry.object.objectKey);
      ensure(head.sizeBytes === entry.object.sizeBytes, `ROS object collision (size mismatch): ${entry.object.objectKey}`);
      present = true;
    } catch (error) {
      if (!(error instanceof StorageError) || !error.notFound) throw error;
    }
    if (present) {
      result.existingObjects += 1;
    } else {
      ensure(args.apply, `ROS object is missing in verify-only mode: ${entry.object.objectKey}`);
      await storage.putObject({
        objectKey: entry.object.objectKey,
        body: createReadStream(entry.localPath),
        sizeBytes: entry.object.sizeBytes,
        contentType: entry.object.mime,
        cacheControl: IMMUTABLE_OBJECT_CACHE_CONTROL,
      });
      result.uploadedObjects += 1;
      result.bytesUploaded += entry.object.sizeBytes;
    }
    const verification = await storage.verifyObject(entry.object.objectKey, { sizeBytes: entry.object.sizeBytes, sha256: entry.object.sha256 });
    ensure(verification.verified, `ROS object verification failed: ${entry.object.objectKey}`);
    result.verifiedObjects += 1;
    if ((index + 1) % 25 === 0 || index + 1 === localPlan.entries.length) {
      console.log(JSON.stringify({ status: "ROS_UPLOAD_PROGRESS", completed: index + 1, total: localPlan.entries.length, existingObjects: result.existingObjects, uploadedObjects: result.uploadedObjects, verifiedObjects: result.verifiedObjects, bytesUploaded: result.bytesUploaded }));
    }
  }
  return result;
}

async function writeReport(reportPath: string, value: Record<string, unknown>): Promise<void> {
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(value, null, 2) + "\n", "utf8");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const localPlan = await buildLocalPlan(args.planPath);
  const ros = rosStorageStatus(loadRosStorageConfig());
  const mode = args.apply ? "upload" : args.verifyOnly ? "verify-only" : "local-dry-run";
  const baseReport: Record<string, unknown> = {
    schemaVersion: "rotaeno.ros-upload.v1",
    status: mode === "local-dry-run" ? "LOCAL_READY" : "RUNNING",
    mode,
    generatedAt: new Date().toISOString(),
    sourceSnapshot: localPlan.importPlan.sourceSnapshot,
    sourceSha256: localPlan.importPlan.sourceSha256,
    releaseId: localPlan.importPlan.releaseId,
    resourceCount: localPlan.resources.length,
    renditionCount: localPlan.renditions.length,
    objectCount: localPlan.entries.length,
    roleCounts: localPlan.roleCounts,
    objectListSha256: localPlan.objectListSha256,
    localBytes: localPlan.localBytes,
    ros: {
      configured: ros.configured,
      endpoint: ros.endpoint,
      bucket: ros.bucket,
      publicBaseUrl: ros.publicBaseUrl,
      credentialsRecorded: false,
    },
    remoteWrite: mode === "local-dry-run" ? "DISABLED" : mode === "upload" ? "AUTHORIZED" : "NONE",
  };
  if (mode === "local-dry-run") {
    await writeReport(args.reportPath, baseReport);
    console.log(JSON.stringify({ status: "LOCAL_READY", mode, resourceCount: localPlan.resources.length, renditionCount: localPlan.renditions.length, objectCount: localPlan.entries.length, webpRenditions: localPlan.roleCounts["thumbnail-320"]! + localPlan.roleCounts["thumbnail-640"]! + localPlan.roleCounts["thumbnail-1280"]!, reportPath: args.reportPath }, null, 2));
    return;
  }
  ensure(ros.configured, "ROS credentials are not configured");
  try {
    const result = await runRemote(localPlan, args);
    await writeReport(args.reportPath, { ...baseReport, status: args.apply ? "ROS_OBJECTS_VERIFIED" : "ROS_OBJECTS_VERIFIED_READ_ONLY", completedAt: new Date().toISOString(), ...result, failedObjects: [] });
    console.log(JSON.stringify({ status: args.apply ? "ROS_OBJECTS_VERIFIED" : "ROS_OBJECTS_VERIFIED_READ_ONLY", resourceCount: localPlan.resources.length, renditionCount: localPlan.renditions.length, objectCount: localPlan.entries.length, ...result, reportPath: args.reportPath }, null, 2));
  } catch (error) {
    const failure = { message: safeError(error) };
    await writeReport(args.reportPath, { ...baseReport, status: "FAILED", completedAt: new Date().toISOString(), failedObjects: [failure] });
    throw error;
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ status: "ERROR", message: safeError(error) }));
  process.exitCode = 1;
});
