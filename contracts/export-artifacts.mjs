// Copies ABI + bytecode from Foundry's build output into the API (run after `./forge.sh build`).
// CI rebuilds and fails if the committed artifacts differ (they must match the contracts).
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
for (const name of ['ExchangeVault', 'TestToken']) {
  const built = JSON.parse(readFileSync(join(here, 'out', `${name}.sol`, `${name}.json`), 'utf8'));
  const out = { contractName: name, abi: built.abi, bytecode: built.bytecode.object };
  writeFileSync(
    join(here, '..', 'apps', 'api', 'src', 'chain', 'artifacts', `${name}.json`),
    `${JSON.stringify(out, null, 2)}\n`,
  );
}
