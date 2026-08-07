import { describe, expect, it } from 'vitest';
import { AuthError, KeeneticError, RciError, TransportError } from '../../src/router/errors.js';

describe('error taxonomy', () => {
  it('every error carries guidance a model can act on', () => {
    const err = new AuthError('the router rejected credentials for user "admin"');
    expect(err).toBeInstanceOf(KeeneticError);
    expect(err.guidance).toContain('keenetic-mcp init');
  });

  it('formats a full message combining cause and guidance', () => {
    const err = new TransportError('connection refused at 192.0.2.1:80');
    expect(err.message).toContain('connection refused');
    expect(err.message).toContain(err.guidance);
  });

  it('RciError keeps the router diagnostics for the caller', () => {
    const err = new RciError('unable to find (empty)', {
      path: 'show/interface/stat',
      code: '6553609',
      ident: 'Network::Interface::Base'
    });
    expect(err.path).toBe('show/interface/stat');
    expect(err.code).toBe('6553609');
    expect(err.ident).toBe('Network::Interface::Base');
    expect(err.message).toContain('show/interface/stat');
  });
});
