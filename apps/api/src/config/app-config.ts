import { apiEnvSchema, parseEnv, type ApiEnv } from '@platform/config';

export const APP_CONFIG = Symbol('APP_CONFIG');
export type AppConfig = ApiEnv;

export function loadAppConfig(source: Record<string, string | undefined> = process.env): AppConfig {
  return parseEnv(apiEnvSchema, source);
}
