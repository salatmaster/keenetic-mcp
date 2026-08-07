import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import {
  configDir,
  gatewayCommand,
  identifyRouter,
  parseGateway,
  writeStoredConfig
} from '../config/discover.js';
import { createSecretStore, spawnRunner, type SecretStore } from '../config/secrets.js';
import { createClient } from '../router/client.js';

export interface VerifyOk {
  ok: true;
  model: string;
  firmware: string;
  components: number;
}

export interface VerifyFailed {
  ok: false;
  reason: string;
}

export interface InitDeps {
  configDir: string;
  /** Reads a visible line; returns '' when the user just presses enter. */
  prompt: (question: string, fallback: string) => Promise<string>;
  /** Reads a line without echoing it. */
  hidden: (question: string) => Promise<string>;
  out: (line: string) => void;
  store: SecretStore;
  discoverGateway: () => Promise<string | null>;
  identify: (host: string) => Promise<{ realm: string } | null>;
  verify: (host: string, login: string, password: string) => Promise<VerifyOk | VerifyFailed>;
}

/**
 * The whole flow, with every side effect injected, so it is tested without a
 * router, a terminal or a keychain. Nothing is written until the credentials
 * have actually authenticated.
 */
export async function runInit(deps: InitDeps): Promise<number> {
  const guess = (await deps.discoverGateway()) ?? '192.168.1.1';
  const host = (await deps.prompt('Router address', guess)) || guess;

  const identified = await deps.identify(host);
  if (!identified) {
    deps.out(`Nothing at ${host} looks like a Keenetic router.`);
    deps.out('Check the address, and that this machine is on the same network.');
    return 1;
  }
  deps.out(`Found ${identified.realm} at ${host}`);

  const login = (await deps.prompt('Login', 'admin')) || 'admin';
  const password = await deps.hidden('Password');

  const result = await deps.verify(host, login, password);
  if (!result.ok) {
    deps.out(`The router rejected those credentials (${result.reason}). Nothing was saved.`);
    return 1;
  }
  deps.out(`${result.model}, KeeneticOS ${result.firmware}, ${result.components} components`);

  const path = await writeStoredConfig(deps.configDir, { host, login });
  const where = await deps.store.save(`${login}@${host}`, password);

  deps.out('');
  deps.out(`Password stored in ${where}`);
  deps.out(`Settings written to ${path}`);
  deps.out('');
  deps.out('Add it to your agent. The plugin brings the skills along with the server:');
  deps.out('');
  deps.out('  Claude Code   /plugin marketplace add salatmaster/keenetic-mcp');
  deps.out('                /plugin install keenetic@keenetic');
  deps.out('');
  deps.out('  Codex         codex plugin marketplace add salatmaster/keenetic-mcp');
  deps.out('                codex plugin add keenetic@keenetic');
  deps.out('');
  deps.out('  Anything else {"command": "npx", "args": ["-y", "keenetic-mcp"]}');
  return 0;
}

async function readGateway(): Promise<string | null> {
  const cmd = gatewayCommand(process.platform);
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawn(cmd.command, cmd.args, { stdio: ['ignore', 'pipe', 'ignore'] });
      let buffer = '';
      child.stdout.on('data', chunk => {
        buffer += String(chunk);
      });
      child.on('error', reject);
      child.on('close', () => resolve(buffer));
    });
    return parseGateway(process.platform, stdout);
  } catch {
    return null;
  }
}

interface LineSource {
  ask(question: string, echo: boolean): Promise<string>;
  close(): void;
}

/**
 * Reads a secret from the terminal without echoing it.
 *
 * Raw mode rather than readline: in terminal mode readline redraws the current
 * line, which erases a prompt written straight to stdout, and muting its
 * private `_writeToOutput` does not suppress the echo on current Node. Raw mode
 * turns the echo off at the terminal, so nothing can leak it.
 */
function readSecret(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const { stdin, stdout } = process;
    stdout.write(question);

    const wasRaw = stdin.isRaw === true;
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();

    let secret = '';

    const stop = (): void => {
      stdin.off('data', onData);
      if (stdin.isTTY) stdin.setRawMode(wasRaw);
      stdin.pause();
      stdout.write('\n');
    };

    const onData = (chunk: Buffer): void => {
      for (const char of chunk.toString('utf8')) {
        switch (char) {
          case '\r':
          case '\n':
          case '\u0004': // Ctrl-D, an empty password
            stop();
            resolve(secret);
            return;
          case '\u0003': // Ctrl-C
            stop();
            reject(new Error('cancelled'));
            return;
          case '\u007f': // Delete
          case '\b':
            secret = secret.slice(0, -1);
            break;
          default:
            // Skip the rest of the control range, including escape sequences
            // from arrow keys, which would otherwise land in the password.
            if (char >= ' ' && char !== '\u007f') secret += char;
        }
      }
    };

    stdin.on('data', onData);
  });
}

/**
 * Reads from a terminal.
 *
 * A readline interface is opened per visible question and closed again, so it
 * is never competing with the raw-mode reader for stdin.
 */
function terminalSource(): LineSource {
  return {
    async ask(question, echo) {
      if (!echo) return readSecret(question);

      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return (await rl.question(question)).trim();
      } finally {
        rl.close();
      }
    },
    close: () => {}
  };
}

/**
 * Answers from a stream that was read to the end up front.
 *
 * A piped stdin is consumed and closed as soon as readline attaches, so by the
 * time the first question is asked the interface is already closed and every
 * read fails with "readline was closed". Buffering first avoids the race and
 * makes the wizard usable from a script.
 */
async function pipedSource(): Promise<LineSource> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const lines = Buffer.concat(chunks).toString('utf8').split('\n');
  let index = 0;
  return {
    async ask(question) {
      process.stdout.write(question);
      const line = lines[index] ?? '';
      index += 1;
      process.stdout.write('\n');
      return line.trim();
    },
    close: () => {}
  };
}

export async function runInitFromTerminal(): Promise<number> {
  const source = process.stdin.isTTY ? terminalSource() : await pipedSource();
  const dir = configDir(process.platform, process.env);

  try {
    return await runInit({
      configDir: dir,
      prompt: (question, fallback) => source.ask(`${question} [${fallback}]: `, true),
      hidden: question => source.ask(`${question}: `, false),
      out: line => process.stdout.write(`${line}\n`),
      store: createSecretStore(process.platform, spawnRunner, dir),
      discoverGateway: readGateway,
      identify: host => identifyRouter(host),
      verify: async (host, login, password) => {
        try {
          const caps = await createClient({ host, login, password }).capabilities();
          return {
            ok: true,
            model: caps.model,
            firmware: caps.firmware,
            components: caps.components.size
          };
        } catch (error) {
          return { ok: false, reason: (error as Error).message.slice(0, 120) };
        }
      }
    });
  } finally {
    source.close();
  }
}
