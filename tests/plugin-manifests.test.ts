import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = new URL('../', import.meta.url);

async function json<T = Record<string, unknown>>(relative: string): Promise<T> {
  return JSON.parse(await readFile(new URL(relative, ROOT), 'utf8')) as T;
}

interface Manifest {
  name: string;
  version: string;
  description: string;
  license?: string;
  skills?: string;
  mcpServers?: string;
}

interface McpConfig {
  mcpServers: Record<string, { command: string; args: string[] }>;
}

/**
 * One plugin directory serves both Claude Code and Codex. They read different
 * manifests but share `.mcp.json` and `skills/`, so the two manifests drift
 * apart silently unless something checks.
 */
describe('plugin manifests', () => {
  it('agree on name and license', async () => {
    const claude = await json<Manifest>('plugins/keenetic/.claude-plugin/plugin.json');
    const codex = await json<Manifest>('plugins/keenetic/.codex-plugin/plugin.json');

    expect(codex.name).toBe(claude.name);
    expect(codex.license).toBe(claude.license);
  });

  // Verified against a plugin OpenAI ships: Codex reads the same camelCase
  // `mcpServers` wrapper Claude Code does, despite its documentation showing a
  // bare server map. That is what lets one .mcp.json serve both.
  it('share one .mcp.json that both readers understand', async () => {
    const mcp = await json<McpConfig>('plugins/keenetic/.mcp.json');
    const server = mcp.mcpServers['keenetic'];

    expect(server, 'the server must be keyed under mcpServers').toBeDefined();
    expect(server?.command).toBe('npx');
    expect(server?.args).toContain('-y');
  });

  it('point the Codex manifest at the shared skills and server', async () => {
    const codex = await json<Manifest>('plugins/keenetic/.codex-plugin/plugin.json');
    expect(codex.skills).toBe('./skills/');
    expect(codex.mcpServers).toBe('./.mcp.json');
  });

  it('list the plugin in the Codex marketplace at a path that exists', async () => {
    const market = await json<{
      name: string;
      plugins: Array<{ name: string; source: { source: string; path: string } }>;
    }>('.agents/plugins/marketplace.json');

    const entry = market.plugins[0];
    expect(entry?.name).toBe('keenetic');
    expect(entry?.source.path).toBe('./plugins/keenetic');

    // The path is relative to the marketplace root, which is the repository root.
    const manifest = await json<Manifest>('plugins/keenetic/.codex-plugin/plugin.json');
    expect(manifest.name).toBe(entry?.name);
  });
});
