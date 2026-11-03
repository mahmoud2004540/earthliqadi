import 'reflect-metadata';
import { createApp } from './bootstrap';
import { loadAppConfigOrExit } from './config/app-config';

async function main(): Promise<void> {
  const config = loadAppConfigOrExit();
  const app = await createApp(config);
  await app.listen(config.API_PORT, config.API_HOST);
}

void main();
