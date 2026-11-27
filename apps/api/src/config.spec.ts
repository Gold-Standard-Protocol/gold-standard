import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseApiHost,
  parseCorsOrigins,
  parsePort,
  parseRateMaxRequests,
  parseTrustProxyHops,
  readApiConfig,
  resolveDappDist,
  trustProxyExposureWarning,
} from './config';

/** Every numeric environment variable is parsed strictly and fails at startup, never as NaN or 0 at runtime. */
describe('api configuration', () => {
  describe('parseRateMaxRequests', () => {
    it('defaults to 120 when unset or blank and accepts a plain integer', () => {
      expect(parseRateMaxRequests(undefined)).toBe(120);
      expect(parseRateMaxRequests('')).toBe(120);
      expect(parseRateMaxRequests('  ')).toBe(120);
      expect(parseRateMaxRequests('300')).toBe(300);
      expect(parseRateMaxRequests(' 1 ')).toBe(1);
    });

    it('refuses the values that used to disable or jam the limiter', () => {
      expect(() => parseRateMaxRequests('abc')).toThrow('RATE_MAX_REQUESTS');
      expect(() => parseRateMaxRequests('0')).toThrow('RATE_MAX_REQUESTS');
      expect(() => parseRateMaxRequests('-5')).toThrow('RATE_MAX_REQUESTS');
      expect(() => parseRateMaxRequests('1e9')).toThrow('RATE_MAX_REQUESTS');
      expect(() => parseRateMaxRequests('0x10')).toThrow('RATE_MAX_REQUESTS');
      expect(() => parseRateMaxRequests('12.5')).toThrow('RATE_MAX_REQUESTS');
      expect(() => parseRateMaxRequests('100001')).toThrow('between 1 and 100000');
    });
  });

  describe('parsePort', () => {
    it('defaults to 3333 and accepts a port in range', () => {
      expect(parsePort(undefined)).toBe(3333);
      expect(parsePort('')).toBe(3333);
      expect(parsePort('3399')).toBe(3399);
    });

    it('refuses anything that is not a port number', () => {
      expect(() => parsePort('0')).toThrow('PORT');
      expect(() => parsePort('65536')).toThrow('PORT');
      expect(() => parsePort('http')).toThrow('PORT');
    });
  });

  describe('parseApiHost', () => {
    it('defaults to loopback, so only a proxy on the same host can reach the listener', () => {
      expect(parseApiHost(undefined)).toBe('127.0.0.1');
      expect(parseApiHost('')).toBe('127.0.0.1');
      expect(parseApiHost('  ')).toBe('127.0.0.1');
    });

    it('takes an explicit IP address as the override', () => {
      expect(parseApiHost('0.0.0.0')).toBe('0.0.0.0');
      expect(parseApiHost(' ::1 ')).toBe('::1');
      expect(parseApiHost('10.0.0.5')).toBe('10.0.0.5');
    });

    it('refuses a name, a port or anything else that is not one IP address', () => {
      expect(() => parseApiHost('localhost')).toThrow('API_HOST must be an IP address');
      expect(() => parseApiHost('api.example.com')).toThrow('API_HOST');
      expect(() => parseApiHost('127.0.0.1:3333')).toThrow('API_HOST');
      expect(() => parseApiHost('[::1]')).toThrow('API_HOST');
      expect(() => parseApiHost('256.0.0.1')).toThrow('API_HOST');
    });
  });

  describe('parseTrustProxyHops', () => {
    it('defaults to zero and accepts an exact hop count', () => {
      expect(parseTrustProxyHops(undefined)).toBe(0);
      expect(parseTrustProxyHops('')).toBe(0);
      expect(parseTrustProxyHops('1')).toBe(1);
    });

    it('refuses anything that is not a small integer', () => {
      expect(() => parseTrustProxyHops('17')).toThrow('TRUST_PROXY_HOPS');
      expect(() => parseTrustProxyHops('one')).toThrow('TRUST_PROXY_HOPS');
      expect(() => parseTrustProxyHops('-1')).toThrow('TRUST_PROXY_HOPS');
    });
  });

  // A listener off loopback that trusts proxy
  // hops gives any client that reaches the port its own rate-limit key unless a firewall
  // admits the proxy alone, and nothing used to say so.
  describe('trustProxyExposureWarning', () => {
    const port = 3333;

    it.each([
      ['127.0.0.1', 1],
      ['127.0.0.2', 1],
      ['::1', 1],
      ['::ffff:127.0.0.1', 1],
      ['127.0.0.1', 0],
      ['::1', 0],
      ['0.0.0.0', 0],
      ['192.168.1.20', 0],
    ])('stays silent for API_HOST %s with TRUST_PROXY_HOPS %i', (host, trustProxyHops) => {
      expect(trustProxyExposureWarning({ host, port, trustProxyHops })).toBeUndefined();
    });

    it.each(['0.0.0.0', '::', '192.168.1.20', '10.0.0.5'])(
      'warns for API_HOST %s with TRUST_PROXY_HOPS 1, naming the firewall and the port',
      (host) => {
        const warning = trustProxyExposureWarning({ host, port: 3399, trustProxyHops: 1 });
        expect(warning).toContain(`API_HOST ${host} is not a loopback address`);
        expect(warning).toContain('TRUST_PROXY_HOPS is 1');
        expect(warning).toContain('A firewall must admit only the counted proxies to port 3399');
      }
    );
  });

  describe('parseCorsOrigins', () => {
    it('parses CORS_ORIGINS strictly', () => {
      expect(parseCorsOrigins(undefined)).toBeUndefined();
      expect(parseCorsOrigins(' ')).toBeUndefined();
      expect(parseCorsOrigins('*')).toBe('*');
      expect(parseCorsOrigins('https://a.example, https://b.example')).toEqual(['https://a.example', 'https://b.example']);
      expect(() => parseCorsOrigins('goldstandard.finance')).toThrow('CORS_ORIGINS');
      expect(() => parseCorsOrigins('https://a.example/path')).toThrow('CORS_ORIGINS');
    });
  });

  describe('resolveDappDist', () => {
    it('is undefined when unset, the directory when it holds a build, and an error otherwise', () => {
      expect(resolveDappDist(undefined)).toBeUndefined();
      expect(resolveDappDist('  ')).toBeUndefined();
      const built = mkdtempSync(join(tmpdir(), 'gsusd-built-'));
      writeFileSync(join(built, 'index.html'), '<!doctype html>');
      writeFileSync(join(built, '_headers'), '/*\n  X-Content-Type-Options: nosniff\n');
      expect(resolveDappDist(built)).toBe(built);
      const empty = mkdtempSync(join(tmpdir(), 'gsusd-empty-'));
      expect(() => resolveDappDist(empty)).toThrow('index.html');
    });

    it('refuses a build without the _headers file that carries its security policy', () => {
      const noHeaders = mkdtempSync(join(tmpdir(), 'gsusd-noheaders-'));
      writeFileSync(join(noHeaders, 'index.html'), '<!doctype html>');
      expect(() => resolveDappDist(noHeaders)).toThrow('_headers');
    });
  });

  describe('readApiConfig', () => {
    it('reads every variable from one environment and applies the defaults', () => {
      expect(readApiConfig({})).toEqual({
        port: 3333,
        host: '127.0.0.1',
        trustProxyHops: 0,
        rateMaxRequests: 120,
        dappDist: undefined,
        corsOrigins: undefined,
      });
      expect(
        readApiConfig({ PORT: '3399', API_HOST: '::', TRUST_PROXY_HOPS: '1', RATE_MAX_REQUESTS: '60', CORS_ORIGINS: '*' })
      ).toEqual({
        port: 3399,
        host: '::',
        trustProxyHops: 1,
        rateMaxRequests: 60,
        dappDist: undefined,
        corsOrigins: '*',
      });
    });

    it('names the offending variable so the operator can fix it', () => {
      expect(() => readApiConfig({ RATE_MAX_REQUESTS: 'abc' })).toThrow('RATE_MAX_REQUESTS must be an integer between 1 and 100000, got "abc"');
      expect(() => readApiConfig({ PORT: 'eighty' })).toThrow('PORT must be an integer');
      expect(() => readApiConfig({ API_HOST: 'example.com' })).toThrow('API_HOST must be an IP address');
    });
  });
});
