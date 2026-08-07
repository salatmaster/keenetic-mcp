/**
 * Read-only smoke test against a real router. Not part of CI.
 *   KEENETIC_TEST_HOST=… KEENETIC_TEST_PASSWORD=… npm run smoke
 */
import { createClient } from '../src/router/client.js';

const host = process.env['KEENETIC_TEST_HOST'];
const password = process.env['KEENETIC_TEST_PASSWORD'];

if (!host || !password) {
  process.stderr.write('KEENETIC_TEST_HOST and KEENETIC_TEST_PASSWORD are required.\n');
  process.exit(1);
}

const client = createClient({
  host,
  login: process.env['KEENETIC_TEST_USER'] ?? 'admin',
  password
});

const caps = await client.capabilities();
process.stdout.write(`model:      ${caps.model}\n`);
process.stdout.write(`firmware:   ${caps.firmware}\n`);
process.stdout.write(`components: ${caps.components.size}\n`);

const hotspot = (await client.rci.get('show/ip/hotspot')) as { host?: unknown[] };
process.stdout.write(`devices:    ${hotspot.host?.length ?? 0}\n`);
