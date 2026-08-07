import { fetchCapabilities, type Capabilities } from './capabilities.js';
import { Rci } from './rci.js';
import { Session, type SessionOptions } from './session.js';

/** The seam the tool layer depends on. Tests substitute a plain object. */
export interface KeeneticClient {
  readonly rci: Rci;
  capabilities(): Promise<Capabilities>;
}

export function createClient(opts: SessionOptions): KeeneticClient {
  const rci = new Rci(new Session(opts));
  // Cached as a promise, not a value, so concurrent first callers share one fetch.
  let pending: Promise<Capabilities> | null = null;

  return {
    rci,
    capabilities(): Promise<Capabilities> {
      pending ??= fetchCapabilities(rci);
      return pending;
    }
  };
}
