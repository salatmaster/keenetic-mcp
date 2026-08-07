import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** The package root. One level up from this file in `src/` and `dist/` alike. */
const ROOT = new URL('../', import.meta.url);

/** What package.json carries in git, so a checkout never claims to be a release. */
export const DEV_VERSION = '0.0.0-dev';

let envLoaded = false;

/**
 * Loads a `.env` sitting next to package.json, if there is one.
 *
 * Deliberately the package root rather than the working directory: an
 * installed copy lives in node_modules and has no `.env` there, so this is a
 * no-op in production and cannot be steered by whatever directory an agent
 * happened to launch the server from. In a checkout it is the repository root,
 * which is where the file is gitignored.
 *
 * Node gives a variable that is already in the environment precedence over the
 * file, so a real `KEENETIC_PASSWORD` is never shadowed by a stale one on disk.
 */
export function loadLocalEnv(): void {
  if (envLoaded) return;
  envLoaded = true;

  const file = fileURLToPath(new URL('.env', ROOT));
  if (existsSync(file)) process.loadEnvFile(file);
}

/**
 * The version reported in the MCP handshake.
 *
 * No version is written down in the sources. package.json carries
 * `0.0.0-dev`, and the release workflow stamps the real one from the git tag
 * just before publishing, without committing it. So a published copy reports
 * what was released, a checkout says `0.0.0-dev`, and there is no third place
 * that can go stale - which is what happened when this was a literal and sat
 * at 0.1.0 while the package shipped 0.2.1.
 *
 * `KEENETIC_MCP_VERSION` overrides it, for reproducing a report against a
 * version you are not running.
 */
export function resolveVersion(): string {
  loadLocalEnv();

  const override = process.env['KEENETIC_MCP_VERSION'];
  if (override !== undefined && override.length > 0) return override;

  const manifest = JSON.parse(
    readFileSync(fileURLToPath(new URL('package.json', ROOT)), 'utf8')
  ) as { version?: unknown };

  return typeof manifest.version === 'string' ? manifest.version : DEV_VERSION;
}
