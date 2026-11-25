import { describe, expect, it, vi, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { Session } from '../../src/router/session.js';
import { AuthError } from '../../src/router/errors.js';

const HOST = '192.0.2.1';
const LOGIN = 'admin';
const PASSWORD = 'p4ssw0rd';
const REALM = 'Keenetic Test';
const CHALLENGE = 'abcdef0123456789';
const COOKIE_NAME = 'Xk3nD0mMy';

function expectedKey(): string {
  const md5 = createHash('md5').update(`${LOGIN}:${REALM}:${PASSWORD}`).digest('hex');
  return createHash('sha256').update(`${CHALLENGE}${md5}`).digest('hex');
}

function challengeResponse(): Response {
  return new Response(null, {
    status: 401,
    headers: {
      'X-NDM-Realm': REALM,
      'X-NDM-Challenge': CHALLENGE,
      'Set-Cookie': `${COOKIE_NAME}=sid-1; Path=/; Max-Age=300; HttpOnly`
    }
  });
}

afterEach(() => vi.restoreAllMocks());


describe('Session authentication', () => {
  it('reads realm and challenge, posts the derived key, then replays the request', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      calls.push({ url: u, init });
      if (u.endsWith('/auth') && init?.method !== 'POST') return challengeResponse();
      if (u.endsWith('/auth')) return new Response(null, { status: 200 });
      if (calls.filter(c => c.url.endsWith('/rci/show/version')).length === 1) {
        return new Response(null, { status: 401 });
      }
      return new Response(JSON.stringify({ title: '5.1.3' }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const session = new Session({ host: HOST, login: LOGIN, password: PASSWORD });
    const res = await session.request('GET', '/rci/show/version');

    expect(res.status).toBe(200);
    const authPost = calls.find(c => c.url.endsWith('/auth') && c.init?.method === 'POST');
    expect(authPost).toBeDefined();
    expect(JSON.parse(String(authPost!.init!.body))).toEqual({
      login: LOGIN,
      password: expectedKey()
    });
  });

  it('sends back the randomly named session cookie', async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/auth') && init?.method !== 'POST') return challengeResponse();
      if (u.endsWith('/auth')) return new Response(null, { status: 200 });
      const cookie = new Headers(init?.headers).get('cookie');
      return new Response(JSON.stringify({ cookie }), { status: cookie ? 200 : 401 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const session = new Session({ host: HOST, login: LOGIN, password: PASSWORD });
    const res = await session.request('GET', '/rci/show/version');
    expect(await res.json()).toEqual({ cookie: `${COOKIE_NAME}=sid-1` });
  });

  it('fails with a clear error when the challenge headers are absent (KeenDNS)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 401 }))
    );

    const session = new Session({ host: HOST, login: LOGIN, password: PASSWORD });
    await expect(session.request('GET', '/rci/show/version')).rejects.toThrow(AuthError);
    await expect(session.request('GET', '/rci/show/version')).rejects.toThrow(/KeenDNS|remote/i);
  });

  it('reports rejected credentials distinctly from a missing challenge', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const u = String(url);
        if (u.endsWith('/auth') && init?.method !== 'POST') return challengeResponse();
        return new Response(null, { status: 401 });
      })
    );

    const session = new Session({ host: HOST, login: LOGIN, password: PASSWORD });
    await expect(session.request('GET', '/rci/show/version')).rejects.toThrow(/rejected credentials/i);
  });
});

describe('Session retry behaviour', () => {
  it('raises AuthError on a second consecutive 401 instead of looping', async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/auth')) {
        return init?.method === 'POST' ? new Response(null, { status: 200 }) : challengeResponse();
      }
      return new Response(null, { status: 401 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const session = new Session({ host: HOST, login: LOGIN, password: PASSWORD });
    await expect(session.request('GET', '/rci/show/version')).rejects.toThrow(AuthError);

    const dataCalls = fetchMock.mock.calls.filter(c => String(c[0]).includes('/rci/')).length;
    expect(dataCalls).toBe(2);
  });

  it('single-flight: three concurrent expired requests trigger exactly one POST /auth', async () => {
    let authPosts = 0;
    const seen = new Set<string>();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const u = String(url);
        if (u.endsWith('/auth')) {
          if (init?.method === 'POST') {
            authPosts += 1;
            await new Promise(resolve => setTimeout(resolve, 10));
            return new Response(null, { status: 200 });
          }
          return challengeResponse();
        }
        if (!seen.has(u)) {
          seen.add(u);
          return new Response(null, { status: 401 });
        }
        return new Response('{"ok":true}', { status: 200 });
      })
    );

    const session = new Session({ host: HOST, login: LOGIN, password: PASSWORD });
    const results = await Promise.all([
      session.request('GET', '/rci/a'),
      session.request('GET', '/rci/b'),
      session.request('GET', '/rci/c')
    ]);

    expect(results.map(r => r.status)).toEqual([200, 200, 200]);
    expect(authPosts).toBe(1);
  });

  it('a failed authentication is not cached - the next call retries it', async () => {
    let authPosts = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const u = String(url);
        if (u.endsWith('/auth')) {
          if (init?.method === 'POST') {
            authPosts += 1;
            return new Response(null, { status: authPosts === 1 ? 401 : 200 });
          }
          return challengeResponse();
        }
        return authPosts >= 2
          ? new Response('{"ok":true}', { status: 200 })
          : new Response(null, { status: 401 });
      })
    );

    const session = new Session({ host: HOST, login: LOGIN, password: PASSWORD });
    await expect(session.request('GET', '/rci/a')).rejects.toThrow(AuthError);
    const res = await session.request('GET', '/rci/a');
    expect(res.status).toBe(200);
    expect(authPosts).toBe(2);
  });
});
