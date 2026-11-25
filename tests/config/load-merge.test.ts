import { describe, expect, it, vi } from 'vitest';
import { loadConfig, selectedProfile } from '../../src/config/load.js';

const STORED = { router: { host: '198.51.100.1', login: 'stored-user' }, profiles: {} };

/** A keychain holding the given accounts, recording what was asked for. */
function keychain(entries: Record<string, string> = { 'stored-user@198.51.100.1': 'stored-pass' }) {
  return vi.fn(async (account: string) => entries[account] ?? null);
}

describe('loadConfig precedence', () => {
  it('lets the environment beat the flag', async () => {
    const cfg = await loadConfig(
      ['--host', '192.0.2.5'],
      { KEENETIC_HOST: '192.0.2.9', KEENETIC_PASSWORD: 'p' } as NodeJS.ProcessEnv,
      STORED
    );
    expect(cfg.host).toBe('192.0.2.9');
  });

  it('points at the wizard when nothing is configured', async () => {
    await expect(loadConfig([], {} as NodeJS.ProcessEnv, undefined)).rejects.toThrow(
      /keenetic-mcp init/
    );
  });

  it('defaults the login to admin', async () => {
    const cfg = await loadConfig(
      [],
      { KEENETIC_HOST: '192.0.2.1' } as NodeJS.ProcessEnv,
      undefined,
      keychain({ 'admin@192.0.2.1': 'p' })
    );
    expect(cfg.login).toBe('admin');
    expect(cfg.password).toBe('p');
    expect(cfg.readOnly).toBe(false);
    expect(cfg.maxResponseBytes).toBe(25_000);
  });

  it('uses stored values and honours --read-only and --max-response-bytes', async () => {
    const cfg = await loadConfig(
      ['--read-only', '--max-response-bytes', '8000'],
      {} as NodeJS.ProcessEnv,
      STORED,
      keychain()
    );
    expect(cfg).toMatchObject({
      host: '198.51.100.1',
      login: 'stored-user',
      password: 'stored-pass'
    });
    expect(cfg.readOnly).toBe(true);
    expect(cfg.maxResponseBytes).toBe(8000);
  });

  it('rejects a nonsense --max-response-bytes', async () => {
    await expect(
      loadConfig(['--max-response-bytes', 'lots'], {} as NodeJS.ProcessEnv, STORED, keychain())
    ).rejects.toThrow(/positive integer/);
  });
});

// The bug from issue #26: the stored router's password went to whichever router
// the environment pointed at, and the 401 that came back read like a typo.
describe('loadConfig reads the password of the router it connects to', () => {
  it('looks up the overridden host, not the stored one', async () => {
    const read = keychain({
      'stored-user@198.51.100.1': 'stored-pass',
      'stored-user@192.0.2.9': 'second-pass'
    });
    const cfg = await loadConfig(
      [],
      { KEENETIC_HOST: '192.0.2.9' } as NodeJS.ProcessEnv,
      STORED,
      read
    );
    expect(cfg.password).toBe('second-pass');
    expect(read).toHaveBeenCalledWith('stored-user@192.0.2.9');
    expect(read).not.toHaveBeenCalledWith('stored-user@198.51.100.1');
  });

  it('looks up the overridden login', async () => {
    const cfg = await loadConfig(
      [],
      { KEENETIC_USER: 'root' } as NodeJS.ProcessEnv,
      STORED,
      keychain({ 'stored-user@198.51.100.1': 'stored-pass', 'root@198.51.100.1': 'root-pass' })
    );
    expect(cfg).toMatchObject({ login: 'root', password: 'root-pass' });
  });

  it('names the account it found no password for, instead of using another', async () => {
    await expect(
      loadConfig(
        ['--host', '192.0.2.5'],
        {} as NodeJS.ProcessEnv,
        STORED,
        keychain()
      )
    ).rejects.toThrow(/No password stored for stored-user@192\.0\.2\.5\. Run "npx keenetic-mcp init"/);
  });

  it('does not touch the keychain when the password is in the environment', async () => {
    const read = keychain();
    await loadConfig([], { KEENETIC_PASSWORD: 'env-pass' } as NodeJS.ProcessEnv, STORED, read);
    expect(read).not.toHaveBeenCalled();
  });
});

describe('profiles', () => {
  const SAME_ADDRESS = {
    router: { host: '192.0.2.1', login: 'admin' },
    profiles: {
      parents: { host: '192.0.2.1', login: 'admin' },
      office: { host: '198.51.100.1', login: 'root' }
    }
  };
  const SECRETS = keychain({
    'admin@192.0.2.1': 'home-pass',
    'parents:admin@192.0.2.1': 'parents-pass',
    'office:root@198.51.100.1': 'office-pass'
  });

  it('uses the default router when no profile is selected', async () => {
    const cfg = await loadConfig([], {} as NodeJS.ProcessEnv, SAME_ADDRESS, SECRETS);
    expect(cfg).toMatchObject({ host: '192.0.2.1', password: 'home-pass', profile: null });
  });

  it('tells two routers at the same address apart by profile', async () => {
    const cfg = await loadConfig(
      [],
      { KEENETIC_PROFILE: 'parents' } as NodeJS.ProcessEnv,
      SAME_ADDRESS,
      SECRETS
    );
    expect(cfg).toMatchObject({ host: '192.0.2.1', password: 'parents-pass', profile: 'parents' });
  });

  it('takes --profile, and lets KEENETIC_PROFILE beat it', async () => {
    const byFlag = await loadConfig(['--profile', 'office'], {} as NodeJS.ProcessEnv, SAME_ADDRESS, SECRETS);
    expect(byFlag).toMatchObject({ host: '198.51.100.1', login: 'root', password: 'office-pass' });

    const byEnv = await loadConfig(
      ['--profile', 'office'],
      { KEENETIC_PROFILE: 'parents' } as NodeJS.ProcessEnv,
      SAME_ADDRESS,
      SECRETS
    );
    expect(byEnv.profile).toBe('parents');
  });

  it('still lets the environment override a profile', async () => {
    const cfg = await loadConfig(
      [],
      { KEENETIC_PROFILE: 'office', KEENETIC_HOST: '198.51.100.9' } as NodeJS.ProcessEnv,
      SAME_ADDRESS,
      keychain({ 'office:root@198.51.100.9': 'moved-pass' })
    );
    expect(cfg).toMatchObject({ host: '198.51.100.9', login: 'root', password: 'moved-pass' });
  });

  it('names the saved profiles when asked for one that does not exist', async () => {
    await expect(
      loadConfig([], { KEENETIC_PROFILE: 'cottage' } as NodeJS.ProcessEnv, SAME_ADDRESS, SECRETS)
    ).rejects.toThrow(/No profile "cottage"\. Saved profiles: parents, office\..*init --profile cottage/);
  });

  it('points at the profiles when there is no default router', async () => {
    await expect(
      loadConfig(
        [],
        {} as NodeJS.ProcessEnv,
        { router: null, profiles: { parents: SAME_ADDRESS.profiles.parents } },
        SECRETS
      )
    ).rejects.toThrow(/Saved profiles: parents\. Choose one with KEENETIC_PROFILE/);
  });

  it('says which profile is missing its password', async () => {
    await expect(
      loadConfig([], { KEENETIC_PROFILE: 'parents' } as NodeJS.ProcessEnv, SAME_ADDRESS, keychain({}))
    ).rejects.toThrow(/admin@192\.0\.2\.1 in profile "parents".*init --profile parents/);
  });

  it('does not find a profile on the object prototype', async () => {
    await expect(
      loadConfig([], { KEENETIC_PROFILE: 'constructor' } as NodeJS.ProcessEnv, SAME_ADDRESS, SECRETS)
    ).rejects.toThrow(/No profile "constructor"/);
  });

  it('rejects a profile name that could not be stored safely', () => {
    for (const name of ["it's", 'a b', '../x', 'x'.repeat(33)]) {
      expect(() => selectedProfile([], { KEENETIC_PROFILE: name } as NodeJS.ProcessEnv)).toThrow(
        /not allowed/
      );
    }
    expect(selectedProfile([], { KEENETIC_PROFILE: '' } as NodeJS.ProcessEnv)).toBeNull();
  });
});
