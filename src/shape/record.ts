/** Router JSON as an object to read fields from, or an empty one when it is not an object. */
export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/** A string field, or '' when it is missing or not a string. */
export function str(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  return typeof value === 'string' ? value : '';
}
