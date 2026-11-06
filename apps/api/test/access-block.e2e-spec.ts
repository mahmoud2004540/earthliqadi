import type { INestApplication } from '@nestjs/common';
import { createApp } from '../src/bootstrap';
import { loadAppConfig } from '../src/config/app-config';
import { DEFAULT_RESTRICTED_COUNTRIES } from '@platform/config';
import { Logger } from '@nestjs/common';
import { TestClient } from './helpers';
import { WsClient, portOf } from './trading-helpers';

/**
 * GEO_RESTRICTED_MODE=block_all (ADR-0024): a restricted location reaches
 * nothing but the public access status, with the counsel-approved default list.
 */
const GEO_ENV = {
  GEO_COUNTRY_HEADER: 'x-edge-country',
  GEO_REGION_HEADER: 'x-edge-region',
  GEO_UNKNOWN_COUNTRY: 'allow',
  GEO_RESTRICTED_MODE: 'block_all',
  RESTRICTED_COUNTRIES: '',
  RESTRICTED_SUBDIVISIONS: '',
};

let app: INestApplication;
let saved: Record<string, string | undefined>;

beforeAll(async () => {
  saved = Object.fromEntries(Object.keys(GEO_ENV).map((k) => [k, process.env[k]]));
  Object.assign(process.env, GEO_ENV);
  if (!process.env.TEST_LOGS) Logger.overrideLogger(false);
  app = await createApp(loadAppConfig());
  await app.listen(0, '127.0.0.1'); // the WebSocket check needs a listening server
}, 60_000);

afterAll(async () => {
  await app.close();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const from = (country: string, region?: string) => ({
  'x-edge-country': country,
  ...(region ? { 'x-edge-region': region } : {}),
});

describe('block_all mode', () => {
  it('uses the counsel-approved list by default and publishes it', async () => {
    const res = await new TestClient(app).get('/v1/access').set(from('US'));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      country: 'US',
      regionRestricted: true,
      restrictedMode: 'block_all',
      restrictedCountries: DEFAULT_RESTRICTED_COUNTRIES.split(','),
      restrictedSubdivisions: ['CA-ON', 'UA-43', 'UA-40', 'UA-14', 'UA-09'],
    });
  });

  it('refuses every other request from a restricted location, before authentication', async () => {
    const client = new TestClient(app);
    for (const [path, headers] of [
      ['/v1/auth/wallet/nonce', from('US')],
      ['/v1/markets', from('IR')],
      ['/v1/me', from('CA', 'ON')],
      ['/v1/me/access', from('UA', '43')],
    ] as const) {
      const res = await client.get(path).set(headers);
      expect({ path, status: res.status, code: res.body.error?.code }).toEqual({
        path,
        status: 451,
        code: 'REGION_RESTRICTED',
      });
    }
    // Writes too (sign-in, cancels, withdrawals), whatever the CSRF or session state.
    const post = await client.agent
      .post('/v1/orders/cancel-all')
      .set('X-Forwarded-For', client.ip)
      .set(from('KP'))
      .send({});
    expect(post.status).toBe(451);
    // Probes stay reachable.
    expect((await client.get('/health/live').set(from('US'))).status).toBe(200);
  });

  it('serves permitted locations normally, including the rest of a partly restricted country', async () => {
    const client = new TestClient(app);
    expect((await client.get('/v1/markets').set(from('DE'))).status).toBe(200);
    expect((await client.get('/v1/markets').set(from('CA', 'QC'))).status).toBe(200);
    expect((await client.get('/v1/markets').set(from('UA', '30'))).status).toBe(200);
    expect((await client.get('/v1/me').set(from('DE'))).status).toBe(401);
  });

  it('refuses market-data WebSockets from a restricted location', async () => {
    const port = portOf(app);
    await expect(WsClient.connect(port, { headers: from('US') })).rejects.toThrow('HTTP 451');
    const ok = await WsClient.connect(port, { headers: from('DE') });
    ok.socket.close();
  });
});
