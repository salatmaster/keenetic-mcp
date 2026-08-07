import { readdir, readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const DIR = new URL('./fixtures/', import.meta.url);

// A MAC that is not in the locally administered 02:… range means a real device leaked.
const REAL_MAC = /\b(?!02:)[0-9a-f]{2}(:[0-9a-f]{2}){5}\b/i;
const PRIVATE_IP = /\b(10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)\b/;
const BASE64_KEY = /\b[A-Za-z0-9+/]{40,}={0,2}\b/;

describe('fixtures contain no real network data', () => {
  it('passes every fixture through the leak detectors', async () => {
    const files = (await readdir(DIR)).filter(name => name.endsWith('.json'));
    expect(files.length).toBeGreaterThan(0);

    for (const name of files) {
      const text = await readFile(new URL(name, DIR), 'utf8');
      expect(REAL_MAC.test(text), `${name} contains a real-looking MAC`).toBe(false);
      expect(PRIVATE_IP.test(text), `${name} contains a private IP`).toBe(false);
      expect(BASE64_KEY.test(text), `${name} contains key-like material`).toBe(false);
    }
  });
});
