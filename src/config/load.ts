export interface AppConfig {
  host: string;
  login: string;
  password: string;
  readOnly: boolean;
  maxResponseBytes: number;
}

export const DEFAULT_MAX_RESPONSE_BYTES = 25_000;

function flagValue(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  return argv[index + 1];
}

export function loadConfig(argv: readonly string[], env: NodeJS.ProcessEnv): AppConfig {
  const host = flagValue(argv, '--host') ?? env['KEENETIC_HOST'];
  if (!host) {
    throw new Error(
      'KEENETIC_HOST is not set. Point it at the router, for example KEENETIC_HOST=192.168.1.1'
    );
  }

  const password = env['KEENETIC_PASSWORD'];
  if (!password) {
    throw new Error('KEENETIC_PASSWORD is not set.');
  }

  const rawMax = flagValue(argv, '--max-response-bytes');
  const parsedMax = rawMax === undefined ? DEFAULT_MAX_RESPONSE_BYTES : Number.parseInt(rawMax, 10);
  if (!Number.isFinite(parsedMax) || parsedMax <= 0) {
    throw new Error(`--max-response-bytes must be a positive integer, got "${rawMax}"`);
  }

  return {
    host,
    login: env['KEENETIC_USER'] ?? 'admin',
    password,
    readOnly: argv.includes('--read-only'),
    maxResponseBytes: parsedMax
  };
}
