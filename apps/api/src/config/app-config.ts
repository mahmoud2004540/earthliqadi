import { EnvValidationError, apiEnvSchema, parseEnv, type ApiEnv } from '@platform/config';

export const APP_CONFIG = Symbol('APP_CONFIG');
export type AppConfig = ApiEnv;

export function loadAppConfig(source: Record<string, string | undefined> = process.env): AppConfig {
  return parseEnv(apiEnvSchema, source);
}

/** For process entry points (server, CLIs): print validation errors without a stack trace and exit 78. */
export function loadAppConfigOrExit(): AppConfig {
  try {
    return loadAppConfig();
  } catch (err) {
    if (err instanceof EnvValidationError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(78); // EX_CONFIG
    }
    throw err;
  }
}
