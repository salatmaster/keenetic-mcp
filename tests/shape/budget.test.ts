import { describe, expect, it } from 'vitest';
import { capList, capText } from '../../src/shape/budget.js';

const wide = (n: number) => Array.from({ length: n }, (_, i) => ({ i, pad: 'x'.repeat(200) }));

describe('capList', () => {
  it('passes a small list through untouched', () => {
    const out = capList([{ a: 1 }, { a: 2 }], 50, 25_000);
    expect(out.items).toHaveLength(2);
    expect(out.truncated).toBe(false);
    expect(out.total).toBe(2);
    expect(out.note).toBeUndefined();
  });

  it('applies the item limit before the byte ceiling', () => {
    const out = capList(wide(100), 10, 25_000);
    expect(out.items).toHaveLength(10);
    expect(out.total).toBe(100);
    expect(out.truncated).toBe(true);
  });

  it('shrinks further when the byte ceiling is the binding constraint', () => {
    const out = capList(wide(100), 100, 2_000);
    expect(out.items.length).toBeLessThan(100);
    expect(JSON.stringify(out.items).length).toBeLessThanOrEqual(2_000);
    expect(out.truncated).toBe(true);
  });

  it('states real numbers in the note so the model can narrow the query', () => {
    const out = capList(wide(455), 50, 25_000);
    expect(out.note).toContain('50');
    expect(out.note).toContain('455');
    expect(out.note).toMatch(/narrow/i);
  });

  it('returns at least one item even when that item alone exceeds the ceiling', () => {
    const out = capList([{ pad: 'x'.repeat(10_000) }], 50, 100);
    expect(out.items).toHaveLength(1);
    expect(out.truncated).toBe(true);
  });

  it('handles an empty list', () => {
    const out = capList([], 50, 25_000);
    expect(out).toMatchObject({ items: [], shown: 0, total: 0, truncated: false });
  });
});

describe('capText', () => {
  it('leaves short text alone', () => {
    expect(capText('hello', 100)).toBe('hello');
  });

  it('truncates long text and says how much was dropped', () => {
    const out = capText('y'.repeat(5_000), 500);
    expect(out.length).toBeLessThan(1_000);
    expect(out).toContain('5000');
  });
});
