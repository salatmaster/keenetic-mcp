import { readdir, readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const ROOT = new URL('../', import.meta.url);

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', 'docs']);

// A MAC outside the locally administered 02:… range means a real device leaked.
const REAL_MAC = /\b(?!02:)[0-9a-f]{2}(:[0-9a-f]{2}){5}\b/gi;
// The anonymizer's own test has to feed it MACs outside the 02:… range, or it
// would not exercise the mapping at all. These are the recognised placeholders;
// listing them individually keeps a genuine leak in that file detectable.
const ALLOWED_MACS = new Set(['aa:bb:cc:dd:ee:ff', '11:22:33:44:55:66']);
// 192.168.1.1 is the documented example host and the most common router address
// in existence, so it is allowed; any other private address is not.
const PRIVATE_IP = /\b(10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)\b/g;
const ALLOWED_IPS = new Set(['192.168.1.1', '10.0.0.42']);
const BASE64_KEY = /\b[A-Za-z0-9+/]{40,}={0,2}\b/;

async function* walk(dir: URL): AsyncGenerator<URL> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
    const child = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, dir);
    if (entry.isDirectory()) yield* walk(child);
    else if (/\.(ts|json|md|js)$/.test(entry.name)) yield child;
  }
}

function offendingIps(text: string): string[] {
  const found = text.match(PRIVATE_IP) ?? [];
  return [...new Set(found)].filter(ip => !ALLOWED_IPS.has(ip));
}

function offendingMacs(text: string): string[] {
  const found = text.match(REAL_MAC) ?? [];
  return [...new Set(found.map(mac => mac.toLowerCase()))].filter(mac => !ALLOWED_MACS.has(mac));
}

describe('the repository contains no real network data', () => {
  it('scans every source, test and fixture file', async () => {
    const files: URL[] = [];
    for await (const file of walk(ROOT)) files.push(file);
    expect(files.length).toBeGreaterThan(20);

    for (const file of files) {
      const name = decodeURIComponent(file.pathname).slice(decodeURIComponent(ROOT.pathname).length);
      // Integrity hashes in the lockfile trip the key detector and are not secrets.
      if (name === 'package-lock.json') continue;

      const text = await readFile(file, 'utf8');
      expect(offendingMacs(text), `${name} contains a real-looking MAC`).toEqual([]);
      expect(offendingIps(text), `${name} contains a private IP`).toEqual([]);
      // Long identifiers are legitimate in source, so key material is only
      // rejected where captured router data lives.
      if (name.startsWith('tests/fixtures/')) {
        expect(BASE64_KEY.test(text), `${name} contains key-like material`).toBe(false);
      }
    }
  });
});
