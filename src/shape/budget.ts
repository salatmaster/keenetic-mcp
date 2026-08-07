export interface CappedList<T> {
  items: T[];
  shown: number;
  total: number;
  truncated: boolean;
  note?: string;
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
}

/**
 * Trims a list to the item limit, then shrinks further until it fits the byte
 * ceiling. At least one item is always returned, even if that single item is
 * over budget - returning nothing would be less useful than returning too much.
 */
export function capList<T>(items: readonly T[], limit: number, maxBytes: number): CappedList<T> {
  const total = items.length;
  let kept = items.slice(0, Math.max(0, limit));

  while (kept.length > 1 && byteLength(kept) > maxBytes) {
    // Halve rather than step down one at a time: a 455-row NAT table would
    // otherwise re-serialise hundreds of times.
    kept = kept.slice(0, Math.max(1, Math.floor(kept.length / 2)));
  }

  const truncated = kept.length < total || (kept.length > 0 && byteLength(kept) > maxBytes);

  const result: CappedList<T> = {
    items: kept,
    shown: kept.length,
    total,
    truncated
  };
  if (kept.length < total) {
    result.note =
      `Showing ${kept.length} of ${total} entries. Narrow the query with the ` +
      `filter, sort or limit parameters to see the rest.`;
  }
  return result;
}

export function capText(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  const head = text.slice(0, maxBytes);
  return `${head}\n\n[truncated: ${text.length} characters total, showing the first ${head.length}]`;
}
