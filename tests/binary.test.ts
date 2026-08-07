import { spawn } from 'node:child_process';
import { mkdtemp, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const DIST = fileURLToPath(new URL('../dist/index.js', import.meta.url));

const INITIALIZE = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'binary-test', version: '0.0.0' }
  }
});

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(entry: string, stdin: string, env: NodeJS.ProcessEnv): Promise<RunResult> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [entry], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => {
      stdout += String(chunk);
    });
    child.stderr.on('data', chunk => {
      stderr += String(chunk);
    });
    child.on('close', code => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

const CONFIGURED: NodeJS.ProcessEnv = {
  ...process.env,
  KEENETIC_HOST: '192.0.2.1',
  KEENETIC_PASSWORD: 'not-used-for-tools-list',
  // Pinned empty rather than left out. The server reads a .env from the
  // repository root when there is one, and a variable already in the
  // environment takes precedence over that file even when it is empty - so
  // this keeps a developer's own .env from deciding what the version test
  // sees, without weakening the assertion below.
  KEENETIC_MCP_VERSION: ''
};

/**
 * These run the built artefact, so `npm run build` must have happened. They
 * exist because everything else in the suite imports `createServer` directly
 * and therefore never exercises the entry-point guard, which is exactly where
 * 0.1.0 was broken.
 */
describe('the built binary', () => {
  it('answers initialize when run by its own path', async () => {
    const result = await run(DIST, `${INITIALIZE}\n`, CONFIGURED);
    expect(result.stdout).toContain('"serverInfo"');
    expect(result.stdout).toContain('keenetic');
  });

  // The version in the handshake is what a client displays and what a bug
  // report quotes, so it has to be the published one. It was a literal in
  // src/index.ts and sat at 0.1.0 while the package shipped 0.2.1. Run against
  // dist because that also proves package.json is reachable from the built
  // layout, which is the only place the runtime read can go wrong - and that
  // is the whole mechanism now, since the release workflow stamps the tag into
  // package.json and nothing else.
  it('reports the package version in serverInfo', async () => {
    const pkg = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8')
    ) as { version: string };

    const result = await run(DIST, `${INITIALIZE}\n`, CONFIGURED);
    const response = JSON.parse(result.stdout.split('\n')[0] ?? '{}') as {
      result?: { serverInfo?: { name?: string; version?: string } };
    };

    expect(response.result?.serverInfo?.name).toBe('keenetic');
    expect(response.result?.serverInfo?.version).toBe(pkg.version);
  });

  // The escape hatch for reproducing a report against a version you are not
  // running. Worth a test because it sits in front of the read above: if the
  // precedence were the other way round it would look like it worked here and
  // do nothing where it matters.
  it('lets KEENETIC_MCP_VERSION override what it reports', async () => {
    const result = await run(DIST, `${INITIALIZE}\n`, {
      ...CONFIGURED,
      KEENETIC_MCP_VERSION: '9.9.9-probe'
    });
    const response = JSON.parse(result.stdout.split('\n')[0] ?? '{}') as {
      result?: { serverInfo?: { version?: string } };
    };

    expect(response.result?.serverInfo?.version).toBe('9.9.9-probe');
  });

  // Regression: npm installs a bin as a symlink in node_modules/.bin, so under
  // npx the entry path is the link and the module path is its target. Version
  // 0.1.0 compared them unresolved, matched nothing, and exited silently.
  it('answers initialize when run through a symlink, the way npx does', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kn-bin-'));
    const link = join(dir, 'keenetic-mcp');
    await symlink(DIST, link);

    const result = await run(link, `${INITIALIZE}\n`, CONFIGURED);
    expect(result.stdout, 'the server produced no output through a symlink').toContain(
      '"serverInfo"'
    );
  });

  it('explains itself and fails when nothing is configured', async () => {
    const bare: NodeJS.ProcessEnv = { ...process.env };
    delete bare['KEENETIC_HOST'];
    delete bare['KEENETIC_PASSWORD'];
    bare['KEENETIC_CONFIG_DIR'] = await mkdtemp(join(tmpdir(), 'kn-empty-'));

    const result = await run(DIST, '', bare);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('keenetic-mcp init');
  });
});
