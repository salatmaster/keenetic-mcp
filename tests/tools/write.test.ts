import { describe, expect, it, vi } from 'vitest';
import { describeWrite, verifiedWrite } from '../../src/tools/write.js';

describe('verifiedWrite', () => {
  it('returns the read-back value when the change took effect', async () => {
    const value = await verifiedWrite({
      apply: vi.fn(async () => ({})),
      readBack: async () => ({ access: 'deny' }),
      check: v => v.access === 'deny',
      what: 'access=deny'
    });
    expect(value).toEqual({ access: 'deny' });
  });

  it('throws when the router accepted the call but changed nothing', async () => {
    await expect(
      verifiedWrite({
        apply: vi.fn(async () => ({})),
        readBack: async () => ({ access: 'permit' }),
        check: (v: { access: string }) => v.access === 'deny',
        what: 'access=deny'
      })
    ).rejects.toThrow(/did not take effect/i);
  });

  it('names the intent in the failure so a model can correct itself', async () => {
    await expect(
      verifiedWrite({
        apply: async () => ({}),
        readBack: async () => ({}),
        check: () => false,
        what: 'policy=Policy0'
      })
    ).rejects.toThrow(/policy=Policy0/);
  });

  it('applies before reading back', async () => {
    const order: string[] = [];
    await verifiedWrite({
      apply: async () => {
        order.push('apply');
        return {};
      },
      readBack: async () => {
        order.push('read');
        return true;
      },
      check: () => true,
      what: 'x'
    });
    expect(order).toEqual(['apply', 'read']);
  });

  it('tolerates a read-back that finds no record at all', async () => {
    await expect(
      verifiedWrite({
        apply: async () => ({}),
        readBack: async (): Promise<Record<string, unknown> | undefined> => undefined,
        check: row => row?.['access'] === 'deny',
        what: 'access=deny'
      })
    ).rejects.toThrow(/did not take effect/i);
  });
});

describe('describeWrite', () => {
  it('always reports the change as unsaved', () => {
    const out = describeWrite({ access: 'deny' }, '/tmp/b.txt');
    expect(out.saved).toBe(false);
    expect(out.unsavedChanges).toBe(true);
    expect(out.backup).toBe('/tmp/b.txt');
  });

  it('tells the caller that a reboot discards the change', () => {
    expect(describeWrite({}, null).note).toMatch(/save_config/);
    expect(describeWrite({}, null).note).toMatch(/reboot/i);
  });
});
