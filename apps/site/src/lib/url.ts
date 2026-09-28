export type UrlConfig = {
  basePath: string;
  origin: string;
  rosBaseUrl: string;
};

export function createUrlHelpers(config: UrlConfig) {
  const basePath = normalizeBasePath(config.basePath);
  const origin = stripTrailingSlash(config.origin);
  const rosBaseUrl = stripTrailingSlash(config.rosBaseUrl);

  return {
    sitePath: (pathname: string): string => sitePath(pathname, basePath),
    absoluteUrl: (pathname: string): string => `${origin}${sitePath(pathname, basePath)}`,
    objectUrl: (objectKey: string): string => objectUrl(objectKey, rosBaseUrl),
  };
}

export function sitePath(pathname: string, basePath: string): string {
  const normalizedBase = normalizeBasePath(basePath);
  const path = pathname.startsWith("/") ? pathname : `/${pathname}`;
  if (normalizedBase === "/") return path;
  return `${normalizedBase.slice(0, -1)}${path}`;
}

export function objectUrl(objectKey: string, rosBaseUrl: string): string {
  const encodedKey = objectKey.split("/").map((part) => encodeURIComponent(part)).join("/");
  return `${stripTrailingSlash(rosBaseUrl)}/${encodedKey}`;
}

export function normalizeBasePath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "/") return "/";
  const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return `${withLeadingSlash.replace(/\/+$/u, "")}/`;
}

export function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, "");
}
