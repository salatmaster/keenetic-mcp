import * as crypto from 'node:crypto';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
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

/**
 * `crypto.argon2` arrived in Node 24.7. Looked up rather than imported, so the
 * module still loads on older Node, which keeps the old login.
 */
const argon2 = (crypto as { argon2?: typeof crypto.argon2 }).argon2;

/** Where the router says to run ndw4, if it offers ndw4 at all. */
export function ndw4Endpoint(wwwAuthenticate: string | null): string | null {
  const chunk = wwwAuthenticate?.match(/x-ndw4-interactive\b([^,]*)/i);
  if (!chunk) return null;
  const endpoint = chunk[1]?.match(/endpoint="([^"]*)"/)?.[1];
  // A path on this host and nothing else: the value comes off the wire and is
  // appended to the router address.
  return endpoint && /^\/[A-Za-z0-9/_-]*$/.test(endpoint) ? endpoint : '/auth';
}

const hmac = (key: Buffer, message: string): Buffer =>
  createHmac('sha3-512', key).update(message).digest();

/** The three SCRAM keys, with Argon2id in place of PBKDF2. */
async function deriveNdw4Keys(
  password: string,
  salt: Buffer,
  iterations: number,
  memoryKib: number
): Promise<{ clientKey: Buffer; storedKey: Buffer; serverKey: Buffer }> {
  if (!argon2) throw new Error('argon2 is not available in this Node');
  const salted = await new Promise<Buffer>((resolve, reject) =>
    argon2(
      'argon2id',
      { message: password, nonce: salt, parallelism: 1, tagLength: 64, memory: memoryKib, passes: iterations },
      (err, key) => (err ? reject(err) : resolve(key))
    )
  );
  const clientKey = hmac(salted, 'NDW4 Interactive Client Key');
  return {
    clientKey,
    storedKey: createHash('sha3-512').update(clientKey).digest(),
    serverKey: hmac(salted, 'NDW4 Interactive Server Key')
  };
}

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

    // 5.2 adds ndw4 and, on some builds, stops accepting ndw2 altogether:
    // a Hopper on 5.2 Beta 3 rejects the ndw2 key for the right password.
    const ndw4 = ndw4Endpoint(probe.headers.get('WWW-Authenticate'));
    if (ndw4 && this.ndw4Available()) return this.authenticateNdw4(ndw4);

    const realm = probe.headers.get('X-NDM-Realm');
    const challenge = probe.headers.get('X-NDM-Challenge');
    if ((!realm || !challenge) && ndw4) {
      throw new AuthError(
        `The router at ${this.opts.host} only offers the ndw4 login, which needs Node 24.7 ` +
          `or later; this is ${process.version}.`
      );
    }
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
        `The router rejected credentials for user "${this.opts.login}" (HTTP ${res.status}).` +
          (ndw4
            ? ` It also offers the newer ndw4 login, which needs Node 24.7 or later; this is ${process.version}.`
            : '')
      );
    }
  }

  /** Overridden by tests to take the path an older Node takes. */
  protected ndw4Available(): boolean {
    return argon2 !== undefined;
  }

  /**
   * SCRAM over SHA3-512 with Argon2id: the password never leaves this machine,
   * and the router has to prove it knows the password too. Each phase answers
   * in a base64 JSON `X-NDM-Data` header; the first two with a non-200, which
   * is expected. Described in Eralde/rci-tools docs/AUTH.md.
   */
  private async authenticateNdw4(endpoint: string): Promise<void> {
    const login = this.opts.login;
    const rejected = (why: string): AuthError =>
      new AuthError(`The router rejected credentials for user "${login}" (ndw4: ${why}).`);

    const clientNonce = randomBytes(16).toString('base64');
    const challenge = await this.ndw4Phase(endpoint, { login, nonce: clientNonce }, rejected);

    const { salt, nonce, iter, memcost } = challenge;
    const saltBytes = typeof salt === 'string' ? Buffer.from(salt, 'base64') : Buffer.alloc(0);
    const iterations = Number(iter);
    const memoryKib = Number(memcost);
    if (
      typeof nonce !== 'string' ||
      !nonce.startsWith(clientNonce) ||
      saltBytes.length !== 16 ||
      !Number.isInteger(iterations) || iterations < 1 || iterations > 64 ||
      !Number.isInteger(memoryKib) || memoryKib < 8 || memoryKib > 262_144
    ) {
      throw rejected('the challenge did not have the expected shape');
    }

    // The raw iter and memcost, exactly as received: the router signs those.
    const authMessage =
      `login1=${login},nonce1=${clientNonce};` +
      `iter2=${String(iter)},memcost2=${String(memcost)},nonce2=${nonce},salt2=${String(salt)};` +
      `login3=${login},nonce3=${nonce}`;

    const keys = await deriveNdw4Keys(this.opts.password, saltBytes, iterations, memoryKib);
    const proof = (message: string): string => {
      const mask = hmac(keys.storedKey, message);
      return Buffer.from(keys.clientKey.map((byte, i) => byte ^ (mask[i] ?? 0))).toString('base64');
    };

    const answer = await this.ndw4Phase(endpoint, { login, nonce, proof: proof(authMessage) }, rejected);
    const signature = typeof answer.signature === 'string' ? answer.signature : '';
    const expected = hmac(keys.serverKey, authMessage);
    const received = Buffer.from(signature, 'base64');
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
      // A router that knows this password would have signed with it. Stop
      // here rather than confirm anything to whoever answered.
      throw rejected('the router did not prove it knows this password, so the password is likely wrong');
    }

    const done = await this.send('POST', endpoint, {
      login,
      nonce,
      'signature-proof': proof(`${authMessage};signature4=${signature}`)
    });
    if (done.status !== 200) throw rejected(`HTTP ${done.status} on the last step`);
  }

  private async ndw4Phase(
    endpoint: string,
    body: Record<string, string>,
    rejected: (why: string) => AuthError
  ): Promise<Record<string, unknown>> {
    const res = await this.send('POST', endpoint, body);
    const data = res.headers.get('X-NDM-Data');
    let reply: Record<string, unknown> = {};
    try {
      reply = data ? (JSON.parse(Buffer.from(data, 'base64').toString('utf8')) as Record<string, unknown>) : {};
    } catch {
      throw rejected(`an unreadable reply (HTTP ${res.status})`);
    }
    const error = reply['error'] ?? reply['e'];
    if (error) throw rejected(String(error));
    if (!data) throw rejected(`no X-NDM-Data in the reply (HTTP ${res.status})`);
    return reply;
  }
}
