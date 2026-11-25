import { describe, expect, it, vi } from 'vitest';
import { describeWrite, verifiedWrite } from '../../src/tools/write.js';

describe('verifiedWrite', () => {
  it('throws when the router accepted the call but changed nothing', async () => {
    await expect(
      verifiedWrite({
        apply: vi.fn(async () => ({})),
        readBack: async () => ({ access: 'permit' }),
        check: (v: { access: string }) => v.access === 'deny',
        what: 'policy=Policy0'
      })
    ).rejects.toThrow(/policy=Policy0 did not take effect/);
  });
});

describe('describeWrite', () => {
  it('tells the caller that a reboot discards the change', () => {
    expect(describeWrite({}, null).note).toMatch(/save_config/);
    expect(describeWrite({}, null).note).toMatch(/reboot/i);
  });
});
