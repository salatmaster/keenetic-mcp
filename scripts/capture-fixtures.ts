/**
 * Captures live router responses into tests/fixtures, anonymized.
 * Run against a real router:
 *   KEENETIC_HOST=… KEENETIC_PASSWORD=… npm run capture:fixtures
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { createClient } from '../src/router/client.js';
import { loadConfig } from '../src/config/load.js';
import { anonymize } from '../src/shape/anonymize.js';

const PATHS = [
  'show/version',
  'show/system',
  'show/interface',
  'show/ip/hotspot',
  'show/ip/route',
  'show/associations',
  'show/internet/status',
  'show/last-change',
  'ip/policy',
  'ip/hotspot/host'
] as const;

const OUT_DIR = new URL('../tests/fixtures/', import.meta.url);

async function main(): Promise<void> {
  const config = loadConfig(process.argv.slice(2), process.env);
  const client = createClient({
    host: config.host,
    login: config.login,
    password: config.password
  });

  await mkdir(OUT_DIR, { recursive: true });

  for (const path of PATHS) {
    const data = await client.rci.get(path);
    const file = new URL(`${path.replaceAll('/', '_')}.json`, OUT_DIR);
    await writeFile(file, `${JSON.stringify(anonymize(data), null, 2)}\n`, 'utf8');
    process.stderr.write(`captured ${path}\n`);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exitCode = 1;
});
