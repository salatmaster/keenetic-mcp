import { RciError } from './errors.js';
import type { Session } from './session.js';

export interface RciStatus {
  status: string;
  code?: string;
  ident?: string;
  message?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Walks the whole response looking for `status` arrays. The router answers
 * HTTP 200 with the failure inside the body, sometimes several levels deep.
 * The `status` key is consumed here and skipped in the generic descent so a
 * block is never counted twice.
 */
export function collectStatuses(value: unknown): RciStatus[] {
  const found: RciStatus[] = [];

  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (!isRecord(node)) return;

    const block = node['status'];
    if (Array.isArray(block)) {
      for (const entry of block) {
        if (isRecord(entry) && typeof entry['status'] === 'string') {
          found.push(entry as unknown as RciStatus);
        }
      }
    }

    for (const [key, child] of Object.entries(node)) {
      if (key === 'status') continue;
      walk(child);
    }
  };

  walk(value);
  return found;
}

export class Rci {
  constructor(private readonly session: Session) {}

  async get<T = unknown>(path: string): Promise<T> {
    const clean = path.replace(/^\/+/, '');
    const res = await this.session.request('GET', `/rci/${clean}`);
    return this.parse<T>(res, clean);
  }

  async post<T = unknown>(body: unknown): Promise<T> {
    const res = await this.session.request('POST', '/rci/', body);
    return this.parse<T>(res, 'POST /rci/');
  }

  /** Plain-text endpoints such as /ci/startup-config.txt. */
  async getText(path: string): Promise<string> {
    const res = await this.session.request('GET', path);
    if (!res.ok) {
      throw new RciError(`HTTP ${res.status}`, { path, code: String(res.status), ident: 'http' });
    }
    return res.text();
  }

  private async parse<T>(res: Response, path: string): Promise<T> {
    if (res.status === 404) {
      throw new RciError(`this path does not exist on this firmware`, {
        path,
        code: '404',
        ident: 'http'
      });
    }
    const text = await res.text();
    if (!res.ok) {
      throw new RciError(`HTTP ${res.status}: ${text.slice(0, 200)}`, {
        path,
        code: String(res.status),
        ident: 'http'
      });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new RciError(
        `the response is not JSON (${text.length} bytes). Some endpoints such as ` +
          `show/netfilter return plain text; read them with a text-aware caller`,
        { path, code: 'parse', ident: 'rci' }
      );
    }

    const errors = collectStatuses(parsed).filter(s => s.status === 'error');
    const first = errors[0];
    if (first) {
      throw new RciError(first.message ?? 'the router reported an error', {
        path,
        code: first.code ?? 'unknown',
        ident: first.ident ?? 'unknown'
      });
    }

    return parsed as T;
  }
}
