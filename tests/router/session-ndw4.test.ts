import * as crypto from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Session, ndw4Endpoint } from '../../src/router/session.js';

const LOGIN = 'admin';
const PASSWORD = 'p4ssw0rd';
const SALT = Buffer.alloc(16, 7).toString('base64');
const SERVER_NONCE = 'c2VydmVyLW5vbmNl';
// Strings on purpose: the router may send them either way, and signs them raw.
const ITER = '1';
const MEMCOST = '8';

const hasArgon2 = typeof (crypto as { argon2?: unknown }).argon2 === 'function';

const hmac = (key: Buffer, message: string): Buffer =>
  crypto.createHmac('sha3-512', key).update(message).digest();

/**
 * The router side of ndw4, written from the protocol description rather than
 * from the client, so the two can disagree. It knows `routerPassword`, which
 * may differ from the one the client was given.
 */
function fakeRouter(opts: { routerPassword?: string; offersNdw2?: boolean; checksProof?: boolean } = {}) {
  const salted = crypto.argon2Sync('argon2id', {
    message: opts.routerPassword ?? PASSWORD,
    nonce: Buffer.from(SALT, 'base64'),
    parallelism: 1,
    tagLength: 64,
    memory: Number(MEMCOST),
    passes: Number(ITER)
  });
  const clientKey = hmac(salted, 'NDW4 Interactive Client Key');
  const storedKey = crypto.createHash('sha3-512').update(clientKey).digest();
  const serverKey = hmac(salted, 'NDW4 Interactive Server Key');

  let authMessage = '';
  let signature = '';
  const bodies: Array<Record<string, string>> = [];
  let authenticated = false;

  const reply = (status: number, data: unknown): Response =>
    new Response(null, {
      status,
      headers: { 'X-NDM-Data': Buffer.from(JSON.stringify(data)).toString('base64') }
    });

  /** What a proof should be for `message`, if the client knows the password. */
  const verify = (message: string, proof: string): boolean => {
    const recovered = Buffer.from(proof, 'base64').map((b, i) => b ^ (hmac(storedKey, message)[i] ?? 0));
    return crypto.createHash('sha3-512').update(recovered).digest().equals(storedKey);
  };

  const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    if (path !== '/auth') {
      return authenticated
        ? new Response('{"title":"5.2"}', { status: 200 })
        : new Response(null, { status: 401 });
    }
    if (init?.method !== 'POST') {
      const schemes = ['x-ndw4-interactive endpoint="/auth" data="e30="'];
      if (opts.offersNdw2 !== false) {
        schemes.push('x-ndw2-interactive realm="Keenetic Test" challenge="abc" session_cookie="Xk3"');
      }
      return new Response(null, {
        status: 401,
        headers: {
          'WWW-Authenticate': schemes.join(', '),
          'X-NDM-Realm': 'Keenetic Test',
          'X-NDM-Challenge': 'abc',
          'Set-Cookie': 'Xk3=sid-1; Path=/; Max-Age=20'
        }
      });
    }

    const body = JSON.parse(String(init.body)) as Record<string, string>;
    bodies.push(body);
    if (body['proof'] === undefined && body['signature-proof'] === undefined) {
      const nonce = `${body['nonce']}${SERVER_NONCE}`;
      authMessage =
        `login1=${body['login']},nonce1=${body['nonce']};` +
        `iter2=${ITER},memcost2=${MEMCOST},nonce2=${nonce},salt2=${SALT};` +
        `login3=${body['login']},nonce3=${nonce}`;
      return reply(401, { salt: SALT, nonce, iter: ITER, memcost: MEMCOST });
    }
    if (body['proof'] !== undefined) {
      if (opts.checksProof !== false && !verify(authMessage, body['proof'])) {
        return reply(401, { error: 'bad proof' });
      }
      signature = hmac(serverKey, authMessage).toString('base64');
      return reply(401, { signature });
    }
    if (!verify(`${authMessage};signature4=${signature}`, body['signature-proof']!)) {
      return new Response(null, { status: 401 });
    }
    authenticated = true;
    return new Response(null, { status: 200 });
  });

  return { fetchMock, bodies };
}

afterEach(() => vi.restoreAllMocks());

describe('ndw4Endpoint', () => {
  it('finds the ndw4 chunk among several schemes', () => {
    expect(ndw4Endpoint('x-ndw2-interactive realm="R" challenge="c", x-ndw4-interactive endpoint="/auth" data="e30="')).toBe('/auth');
  });

  it('is null when only ndw2 is offered', () => {
    expect(ndw4Endpoint('x-ndw2-interactive realm="R" challenge="c"')).toBeNull();
    expect(ndw4Endpoint(null)).toBeNull();
  });

  it('never lets the router point the login somewhere other than a path', () => {
    expect(ndw4Endpoint('x-ndw4-interactive endpoint="@evil.example/auth"')).toBe('/auth');
    expect(ndw4Endpoint('x-ndw4-interactive endpoint="//evil.example/auth"')).toBe('/auth');
  });
});

describe.skipIf(!hasArgon2)('Session over ndw4', () => {
  it('completes the handshake and replays the request', async () => {
    const { fetchMock, bodies } = fakeRouter();
    vi.stubGlobal('fetch', fetchMock);

    const session = new Session({ host: '192.0.2.1', login: LOGIN, password: PASSWORD });
    const res = await session.request('GET', '/rci/show/version');

    expect(res.status).toBe(200);
    expect(bodies.map(b => Object.keys(b).sort())).toEqual([
      ['login', 'nonce'],
      ['login', 'nonce', 'proof'],
      ['login', 'nonce', 'signature-proof']
    ]);
    // ndw2 was offered too and must not have been tried.
    expect(bodies.some(b => 'password' in b)).toBe(false);
  });

  it('reports the error a router puts in its reply', async () => {
    const { fetchMock, bodies } = fakeRouter({ routerPassword: 'other' });
    vi.stubGlobal('fetch', fetchMock);

    const session = new Session({ host: '192.0.2.1', login: LOGIN, password: PASSWORD });
    await expect(session.request('GET', '/rci/show/version')).rejects.toThrow(/ndw4: bad proof/);
    expect(bodies).toHaveLength(2);
  });

  it('stops before the last step when the router cannot prove it knows the password', async () => {
    // A router that skips checking the client and signs with another password:
    // whoever answered does not know this one, so nothing more is sent.
    const { fetchMock, bodies } = fakeRouter({ routerPassword: 'other', checksProof: false });
    vi.stubGlobal('fetch', fetchMock);

    const session = new Session({ host: '192.0.2.1', login: LOGIN, password: PASSWORD });
    await expect(session.request('GET', '/rci/show/version')).rejects.toThrow(/did not prove/);
    expect(bodies.some(b => 'signature-proof' in b)).toBe(false);
  });
});

describe('Session on a Node without argon2', () => {
  class OldNodeSession extends Session {
    protected override ndw4Available(): boolean {
      return false;
    }
  }

  it('falls back to ndw2, and says why when the router refuses it', async () => {
    const posts: Array<Record<string, string>> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string | URL, init?: RequestInit) => {
        if (init?.method === 'POST') {
          posts.push(JSON.parse(String(init.body)) as Record<string, string>);
          return new Response(null, { status: 401 });
        }
        return new Response(null, {
          status: 401,
          headers: {
            'WWW-Authenticate': 'x-ndw4-interactive endpoint="/auth", x-ndw2-interactive realm="R" challenge="c"',
            'X-NDM-Realm': 'R',
            'X-NDM-Challenge': 'c'
          }
        });
      })
    );

    const session = new OldNodeSession({ host: '192.0.2.1', login: LOGIN, password: PASSWORD });
    await expect(session.request('GET', '/rci/show/version')).rejects.toThrow(/Node 24\.7/);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toHaveProperty('password');
  });
});
