import { describe, expect, it } from 'vitest';
import { addressScope, projectDevice, projectInterface } from '../../src/shape/project.js';

const WIRELESS_HOST = {
  mac: '02:00:00:00:00:01',
  ip: '192.0.2.5',
  hostname: 'host-1',
  name: 'device-1',
  interface: { id: 'Bridge0', name: 'Home', description: 'Home network' },
  active: true,
  rxbytes: 1_432_245,
  txbytes: 1_088_893,
  link: 'up',
  ssid: 'ssid-1',
  ap: 'WifiMaster0/AccessPoint0',
  rssi: -36,
  access: 'permit',
  registered: true,
  uptime: 51_256
};

const WIRED_HOST = {
  mac: '02:00:00:00:00:02',
  ip: '192.0.2.6',
  name: 'device-2',
  interface: { id: 'Bridge0', name: 'Home' },
  active: true,
  rxbytes: 10,
  txbytes: 20,
  access: 'deny'
};

describe('projectDevice', () => {
  it('keeps only the summary fields', () => {
    const out = projectDevice(WIRELESS_HOST);
    expect(Object.keys(out).sort()).toEqual(
      ['active', 'blocked', 'connection', 'ip', 'mac', 'name', 'rssi', 'rxBytes', 'txBytes'].sort()
    );
  });

  it('labels a wireless host with its SSID', () => {
    expect(projectDevice(WIRELESS_HOST).connection).toBe('wifi:ssid-1');
  });

  it('labels a wired host with its interface', () => {
    expect(projectDevice(WIRED_HOST).connection).toBe('wired:Home');
  });

  it('maps access=deny to blocked', () => {
    expect(projectDevice(WIRED_HOST).blocked).toBe(true);
    expect(projectDevice(WIRELESS_HOST).blocked).toBe(false);
  });

  it('reports rssi as null for wired hosts rather than inventing a number', () => {
    expect(projectDevice(WIRED_HOST).rssi).toBeNull();
    expect(projectDevice(WIRELESS_HOST).rssi).toBe(-36);
  });

  it('falls back to the hostname, then the MAC, when name is absent', () => {
    expect(projectDevice({ mac: '02:00:00:00:00:03', hostname: 'host-9' }).name).toBe('host-9');
    expect(projectDevice({ mac: '02:00:00:00:00:04' }).name).toBe('02:00:00:00:00:04');
  });

  it('survives a host record missing every optional field', () => {
    const out = projectDevice({ mac: '02:00:00:00:00:05' });
    expect(out).toMatchObject({ ip: '', active: false, rxBytes: 0, txBytes: 0, blocked: false });
  });
});

describe('projectInterface', () => {
  it('keeps only the summary fields', () => {
    const out = projectInterface('Wireguard3', {
      type: 'Wireguard',
      description: 'desc-1',
      link: 'up',
      state: 'up',
      address: '198.51.100.8',
      defaultgw: true,
      wireguard: { 'public-key': '<redacted>' }
    });
    expect(out).toEqual({
      id: 'Wireguard3',
      type: 'Wireguard',
      description: 'desc-1',
      link: 'up',
      state: 'up',
      address: '198.51.100.8',
      defaultGateway: true,
      addressScope: 'public'
    });
  });

  it('gives a WireGuard tunnel with one peer that peer as the likely exit', () => {
    const peer = { 'remote-endpoint-address': '203.0.113.20' };
    expect(projectInterface('Wireguard3', { wireguard: { peer: [peer] } }).likelyExit).toBe('203.0.113.20');
    // Several peers: the router is the server and the endpoints are its clients.
    expect(projectInterface('Wireguard4', { wireguard: { peer: [peer, peer] } }).likelyExit).toBeUndefined();
  });

  it('defaults missing fields to empty values rather than undefined', () => {
    expect(projectInterface('Bridge0', {})).toEqual({
      id: 'Bridge0',
      type: '',
      description: '',
      link: '',
      state: '',
      address: '',
      defaultGateway: false
    });
  });
});

describe('addressScope', () => {
  it.each([
    ['10.0.0.42', 'private'],
    ['172.16.0.1', 'private'],
    ['172.15.0.1', 'public'],
    ['192.168.1.1', 'private'],
    ['169.254.0.5', 'private'],
    ['100.64.0.1', 'cgnat'],
    ['100.127.255.254', 'cgnat'],
    ['100.128.0.1', 'public'],
    ['172.32.0.1', 'public'],
    ['203.0.113.9', 'public']
  ])('classifies %s as %s', (address, scope) => {
    expect(addressScope(address)).toBe(scope);
  });

  it('has no scope for an empty or non-IPv4 address', () => {
    expect(addressScope('')).toBeUndefined();
    expect(addressScope('2001:db8::1')).toBeUndefined();
    expect(addressScope('1.2.3.256')).toBeUndefined();
  });
});
