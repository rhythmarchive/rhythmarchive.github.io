/** This module belongs only in the future Access-protected Worker bundle. */
export type D1ReadBinding = {
  prepare(query: string): {
    bind(...values: unknown[]): { all<T>(): Promise<{ results: T[] }> };
    first<T>(): Promise<T | null>;
  };
};

export type OperatorEnvironment = {
  DB: D1ReadBinding;
  CF_ACCESS_TEAM_DOMAIN: string;
  CF_ACCESS_AUD: string;
  CF_ACCOUNT_ID: string;
  CF_ANALYTICS_API_TOKEN?: string;
  RAINYUN_API_KEY?: string;
  RAINYUN_ROS_ID?: string;
  GITHUB_REPOSITORY: string;
  GITHUB_TOKEN?: string;
};

export type OperatorPublicConfig = {
  accessIssuer: string;
  accessAudience: string;
  accountId: string;
  rosId?: string;
  githubRepository: string;
};

/** Fail closed before constructing any provider; never return or log a secret. */
export function publicRuntimeConfig(env: OperatorEnvironment): OperatorPublicConfig {
  const required = [env.CF_ACCESS_TEAM_DOMAIN, env.CF_ACCESS_AUD, env.CF_ACCOUNT_ID, env.GITHUB_REPOSITORY];
  if (required.some((value) => !value?.trim()) || !env.DB) throw new Error("Operator runtime is not configured");
  const issuer = new URL(env.CF_ACCESS_TEAM_DOMAIN);
  if (issuer.protocol !== "https:" || !issuer.hostname.endsWith(".cloudflareaccess.com") || issuer.pathname !== "/") throw new Error("Operator Access issuer is invalid");
  return {
    accessIssuer: issuer.origin,
    accessAudience: env.CF_ACCESS_AUD,
    accountId: env.CF_ACCOUNT_ID,
    ...(env.RAINYUN_ROS_ID ? { rosId: env.RAINYUN_ROS_ID } : {}),
    githubRepository: env.GITHUB_REPOSITORY,
  };
}
