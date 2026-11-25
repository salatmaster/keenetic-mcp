import { asRecord, str } from '../shape/record.js';

export interface Capabilities {
  model: string;
  hwId: string;
  firmware: string;
  components: ReadonlySet<string>;
  features: ReadonlySet<string>;
}

function splitList(value: unknown): Set<string> {
  if (typeof value !== 'string') return new Set();
  return new Set(
    value
      .split(',')
      .map(part => part.trim())
      .filter(part => part.length > 0)
  );
}

/** Shapes `show/version` into the capability set the tool registry gates on. */
export function parseCapabilities(version: unknown): Capabilities {
  const root = asRecord(version);
  const ndw = asRecord(root['ndw']);

  return {
    model: str(root, 'model'),
    hwId: str(root, 'hw_id'),
    firmware: str(root, 'title'),
    components: splitList(ndw['components']),
    features: splitList(ndw['features'])
  };
}

