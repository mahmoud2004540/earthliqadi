import 'reflect-metadata';
import { EnvValidationError } from '@platform/config';
import { createApp } from './bootstrap';
import { loadAppConfig } from './config/app-config';

async function main(): Promise<void> {
  let config;
  try {
    config = loadAppConfig();
  } catch (err) {
    if (err instanceof EnvValidationError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(78); // EX_CONFIG
    }
    throw err;
  }
  const app = await createApp(config);
  await app.listen(config.API_PORT, config.API_HOST);
}

void main();
