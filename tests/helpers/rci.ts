import { RciError } from '../../src/router/errors.js';
import type { Rci } from '../../src/router/rci.js';

type PostFn = (body: unknown) => Promise<unknown>;

/**
 * A router that answers GET from `paths` and 404s like a real one for anything
 * else. `paths` is read on every call, so a test can change it as it goes.
 */
export function rciWith(paths: Record<string, unknown>, post: PostFn = async () => ({})): Rci {
  return {
    get: async (path: string) => {
      if (path in paths) return paths[path];
      throw new RciError('this path does not exist on this firmware', {
        path,
        code: '404',
        ident: 'http'
      });
    },
    post
  } as unknown as Rci;
}

/** Every `parse` line a run sent, in order. */
export function parseLines(post: { mock: { calls: unknown[][] } }): string[] {
  return post.mock.calls
    .flatMap(([body]) => (Array.isArray(body) ? body : [body]))
    .map(entry => (entry as { parse?: string }).parse)
    .filter((line): line is string => typeof line === 'string');
}
