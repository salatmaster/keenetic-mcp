import { createHash } from 'node:crypto';
import { AuthError, TransportError } from './errors.js';

export interface SessionOptions {
  host: string;
  login: string;
  password: string;
  timeoutMs?: number;
}

/**
 * The Keenetic LAN handshake: MD5 over the credential triple, then SHA256 over
 * the challenge concatenated with that digest. Both digests are lowercase hex.
 */
export function deriveAuthKey(
  login: string,
  realm: string,
  password: string,
  challenge: string
): string {
  const md5 = createHash('md5').update(`${login}:${realm}:${password}`).digest('hex');
  return createHash('sha256').update(`${challenge}${md5}`).digest('hex');
}

const DEFAULT_TIMEOUT_MS = 10_000;

export class Session {
  private readonly opts: SessionOptions;
  /** The router randomises the cookie name, so both parts are stored verbatim. */
  private cookie: string | null = null;
  /** Set while an authentication is in flight so concurrent callers share it. */
  private authInFlight: Promise<void> | null = null;

  constructor(opts: SessionOptions) {
    this.opts = opts;
  }

  /**
   * Lazy authentication: the first 401 drives the handshake, then the call
   * replays exactly once. The session is a 300-second sliding window, so an
   * idle gap between agent turns routinely expires it.
   */
  async request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Response> {
    const first = await this.send(method, path, body);
    if (first.status !== 401) return first;

    await this.ensureAuthenticated();

    const second = await this.send(method, path, body);
    if (second.status === 401) {
      throw new AuthError(
        `The router rejected credentials for user "${this.opts.login}" after ` +
          `re-authenticating for ${method} ${path}.`
      );
    }
    return second;
  }

  private async ensureAuthenticated(): Promise<void> {
    if (!this.authInFlight) {
      // Cleared in `finally` so a rejected attempt is never cached: the next
      // caller starts a fresh handshake rather than inheriting the failure.
      this.authInFlight = this.authenticate().finally(() => {
        this.authInFlight = null;
      });
    }
    return this.authInFlight;
  }

  protected async send(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = {};
    if (this.cookie) headers['cookie'] = this.cookie;
    if (body !== undefined) headers['content-type'] = 'application/json';

    const url = `http://${this.opts.host}${path}`;
    // Built stepwise rather than with a ternary: under exactOptionalPropertyTypes
    // an explicit `body: undefined` is not the same as omitting the property.
    const init: RequestInit = {
      method,
      headers,
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      redirect: 'manual'
    };
    if (body !== undefined) init.body = JSON.stringify(body);

    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (cause) {
      throw new TransportError(`${method} ${url} failed: ${(cause as Error).message}.`);
    }
    this.captureCookie(res);
    return res;
  }

  protected captureCookie(res: Response): void {
    const set = res.headers.getSetCookie();
    for (const raw of set) {
      const pair = raw.split(';', 1)[0];
      if (pair && pair.includes('=')) this.cookie = pair;
    }
  }

  protected async authenticate(): Promise<void> {
    const probe = await this.send('GET', '/auth');
    if (probe.status === 200) return;

    const realm = probe.headers.get('X-NDM-Realm');
    const challenge = probe.headers.get('X-NDM-Challenge');
    if (!realm || !challenge) {
      throw new AuthError(
        `The router at ${this.opts.host} did not return an X-NDM-Challenge. ` +
          'This endpoint does not use the LAN challenge scheme - remote access over ' +
          'KeenDNS is not supported in this version.'
      );
    }

    const password = deriveAuthKey(this.opts.login, realm, this.opts.password, challenge);
    const res = await this.send('POST', '/auth', { login: this.opts.login, password });
    if (res.status !== 200) {
      throw new AuthError(
        `The router rejected credentials for user "${this.opts.login}" (HTTP ${res.status}).`
      );
    }
  }
}
