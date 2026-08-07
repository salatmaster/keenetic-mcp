import { describe, expect, it, vi, afterEach } from 'vitest';
import { Session } from '../../src/router/session.js';
import { AuthError } from '../../src/router/errors.js';

const BASE = { host: '192.0.2.1', login: 'admin', password: 'p4ssw0rd' };

function challenge(): Response {
  return new Response(null, {
    status: 401,
    headers: {
      'X-NDM-Realm': 'Keenetic Test',
      'X-NDM-Challenge': 'abcdef0123456789',
      'Set-Cookie': 'Xk3nD0mMy=sid-1; Path=/; Max-Age=300'
    }
  });
}

afterEach(() => vi.restoreAllMocks());

describe('Session retry behaviour', () => {
  it('re-authenticates once and replays, then succeeds', async () => {
    let dataCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const u = String(url);
        if (u.endsWith('/auth')) {
          return init?.method === 'POST' ? new Response(null, { status: 200 }) : challenge();
        }
        dataCalls += 1;
        return dataCalls === 1
          ? new Response(null, { status: 401 })
          : new Response('{"ok":true}', { status: 200 });
      })
    );

    const session = new Session(BASE);
    const res = await session.request('GET', '/rci/show/version');
    expect(res.status).toBe(200);
    expect(dataCalls).toBe(2);
  });

  it('raises AuthError on a second consecutive 401 instead of looping', async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/auth')) {
        return init?.method === 'POST' ? new Response(null, { status: 200 }) : challenge();
      }
      return new Response(null, { status: 401 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const session = new Session(BASE);
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
          return challenge();
        }
        if (!seen.has(u)) {
          seen.add(u);
          return new Response(null, { status: 401 });
        }
        return new Response('{"ok":true}', { status: 200 });
      })
    );

    const session = new Session(BASE);
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
          return challenge();
        }
        return authPosts >= 2
          ? new Response('{"ok":true}', { status: 200 })
          : new Response(null, { status: 401 });
      })
    );

    const session = new Session(BASE);
    await expect(session.request('GET', '/rci/a')).rejects.toThrow(AuthError);
    const res = await session.request('GET', '/rci/a');
    expect(res.status).toBe(200);
    expect(authPosts).toBe(2);
  });
});
