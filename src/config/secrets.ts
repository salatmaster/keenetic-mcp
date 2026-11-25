import { spawn } from 'node:child_process';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const SERVICE = 'keenetic-mcp';

export type Runner = (
  command: string,
  args: string[],
  stdin?: string
) => Promise<{ code: number; stdout: string }>;

export interface SecretStore {
  /** Returns a human-readable description of where the secret went. */
  save(account: string, secret: string): Promise<string>;
  read(account: string): Promise<string | null>;
}

/**
 * How the secret reaches the keychain tool.
 *
 * `stdin` is preferred, because argv is readable by other processes of the same
 * user. macOS leaves no choice: `security add-generic-password` takes the
 * password as an argument, and its interactive mode re-tokenises the line, which
 * silently truncates any password containing a quote or a space.
 */
export type SecretChannel = 'argv' | 'stdin';

export interface KeychainCommand {
  command: string;
  args: string[];
  secretVia: SecretChannel;
}

/** Runs a command, feeding stdin when given, and never echoes it. */
export const spawnRunner: Runner = (command, args, stdin) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'ignore'] });
    let stdout = '';
    child.stdout.on('data', chunk => {
      stdout += String(chunk);
    });
    child.on('error', reject);
    child.on('close', code => resolve({ code: code ?? 1, stdout }));
    child.stdin.end(stdin ?? '');
  });

export function keychainCommand(
  platform: NodeJS.Platform,
  op: 'save' | 'read',
  account: string
): KeychainCommand {
  if (platform === 'darwin') {
    const target = ['-a', account, '-s', SERVICE];
    return {
      command: 'security',
      args:
        op === 'save'
          ? ['add-generic-password', '-U', ...target, '-w']
          : ['find-generic-password', ...target, '-w'],
      secretVia: 'argv'
    };
  }

  if (platform === 'win32') {
    const verb = op === 'save' ? 'Write' : 'Read';
    return {
      command: 'powershell',
      args: ['-NoProfile', '-Command', `${verb}-KeeneticSecret -Account '${account}'`],
      secretVia: 'stdin'
    };
  }

  const attributes = ['service', SERVICE, 'account', account];
  return {
    command: 'secret-tool',
    args: op === 'save' ? ['store', '--label', SERVICE, ...attributes] : ['lookup', ...attributes],
    secretVia: 'stdin'
  };
}

export function createSecretStore(
  platform: NodeJS.Platform,
  run: Runner,
  fallbackDir: string
): SecretStore {
  const fallbackFile = join(fallbackDir, 'secrets.json');

  async function readFallback(): Promise<Record<string, string>> {
    try {
      return JSON.parse(await readFile(fallbackFile, 'utf8')) as Record<string, string>;
    } catch {
      return {};
    }
  }

  async function writeFallbackFile(all: Record<string, string>): Promise<void> {
    await mkdir(fallbackDir, { recursive: true });
    await writeFile(fallbackFile, `${JSON.stringify(all, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600
    });
    // Set explicitly: an existing file keeps its old mode through writeFile.
    await chmod(fallbackFile, 0o600);
  }

  async function readKeychain(account: string): Promise<string | null> {
    const cmd = keychainCommand(platform, 'read', account);
    try {
      const { code, stdout } = await run(cmd.command, cmd.args);
      if (code === 0 && stdout.trim().length > 0) return stdout.trim();
    } catch {
      // No keychain tool on this machine.
    }
    return null;
  }

  return {
    async save(account, secret) {
      const cmd = keychainCommand(platform, 'save', account);
      try {
        const args = cmd.secretVia === 'argv' ? [...cmd.args, secret] : cmd.args;
        const stdin = cmd.secretVia === 'stdin' ? secret : undefined;
        const { code } = await run(cmd.command, args, stdin);
        // Exit code 0 is not proof: an earlier version reported success while
        // storing an empty string. Confirm by reading the value back.
        if (code === 0 && (await readKeychain(account)) === secret) {
          return 'the system keychain';
        }
      } catch {
        // Fall through to the file.
      }
      const all = await readFallback();
      all[account] = secret;
      await writeFallbackFile(all);
      return `file ${fallbackFile} (no usable system keychain; readable only by you)`;
    },

    async read(account) {
      const fromKeychain = await readKeychain(account);
      if (fromKeychain !== null) return fromKeychain;
      const all = await readFallback();
      return all[account] ?? null;
    },
  };
}
