export const MAX_BATCH_FILES = 30;
export const MAX_BATCH_BYTES = 300 * 1024 * 1024;
export const DOWNLOAD_CONCURRENCY = 3;

import type { PublicDownload, PublicPreview } from "./types";

export type BatchResource = {
  resourceId: string;
  route: string;
  displayTitle: string;
  preview: PublicPreview;
  original?: PublicDownload;
  upscaled?: PublicDownload;
};

export type BatchSelectionToggleResult = {
  selected: string[];
  changed: boolean;
  limited: boolean;
};

export function toggleBatchSelection(selected: readonly string[], resourceId: string, maxSelected = MAX_BATCH_FILES): BatchSelectionToggleResult {
  const next = [...new Set(selected)];
  const index = next.indexOf(resourceId);
  if (index >= 0) {
    next.splice(index, 1);
    return { selected: next, changed: true, limited: false };
  }
  if (next.length >= maxSelected) return { selected: next, changed: false, limited: true };
  next.push(resourceId);
  return { selected: next, changed: true, limited: false };
}

export function uniqueZipFilename(used: Set<string>, filename: string): string {
  const safe = filename.replace(/[<>:"/\\|?*\u0000-\u001f]+/gu, "_").trim() || "resource.bin";
  if (!used.has(safe)) {
    used.add(safe);
    return safe;
  }
  const dot = safe.lastIndexOf(".");
  const base = dot > 0 ? safe.slice(0, dot) : safe;
  const extension = dot > 0 ? safe.slice(dot) : "";
  let index = 2;
  while (used.has(`${base} (${index})${extension}`)) index += 1;
  const result = `${base} (${index})${extension}`;
  used.add(result);
  return result;
}
