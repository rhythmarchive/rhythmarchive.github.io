import { normalizeBasePath, stripTrailingSlash } from "./site-config";

export type UrlConfig = {
  basePath: string;
  origin: string;
  rosBaseUrl: string;
};

export function createUrlHelpers(config: UrlConfig) {
  const basePath = normalizeBasePath(config.basePath);
  const origin = stripTrailingSlash(config.origin);
  const rosBaseUrl = stripTrailingSlash(config.rosBaseUrl);

  const sitePath = (pathname: string): string => {
    const path = pathname.startsWith("/") ? pathname : `/${pathname}`;
    if (basePath === "/") return path;
    return `${basePath.slice(0, -1)}${path}`;
  };

  return {
    sitePath,
    absoluteUrl: (pathname: string): string => `${origin}${sitePath(pathname)}`,
    objectUrl: (objectKey: string): string => objectUrl(objectKey, rosBaseUrl),
  };
}

export function sitePath(pathname: string, basePath: string): string {
  return createUrlHelpers({ basePath, origin: "https://rhythmarchive.github.io", rosBaseUrl: "https://rhythm-assets.cn-nb1.rains3.com" }).sitePath(pathname);
}

export function objectUrl(objectKey: string, rosBaseUrl: string): string {
  const encodedKey = objectKey.split("/").map((part) => encodeURIComponent(part)).join("/");
  return `${stripTrailingSlash(rosBaseUrl)}/${encodedKey}`;
}
