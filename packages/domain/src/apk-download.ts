// Browser-safe APK contract; separate from the resource Catalog and ROS.
export const ARCAEA_APK_STATS_ID = "a4caea00-0000-4000-8000-000000000001";
export function arcaeaR2ObjectKey(version: string, sha256: string): string {
  return `apk/arcaea/${version}/${sha256}/Arcaea_${version}.apk`;
}
export function validArcaeaR2Url(value: string, version: string, sha256: string, base?: string): boolean {
  try {
    if (!base) return false;
    const expected = new URL(`${base.replace(/\/+$/u, "")}/${arcaeaR2ObjectKey(version, sha256)}`);
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.port && !url.search && !url.hash && url.href === expected.href;
  } catch { return false; }
}
