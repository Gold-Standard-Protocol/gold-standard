import { describe, expect, it } from 'vitest';
import { ChainId } from '@goldstandard/models';
import { buildGsusdToken } from './useGsusdToken';

const GSUSD_ADDRESS = '0x1111111111111111111111111111111111111111';
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

describe('buildGsusdToken', () => {
  it('returns undefined when chainId is undefined', () => {
    expect(buildGsusdToken(undefined, GSUSD_ADDRESS)).toBeUndefined();
  });

  it('returns undefined when the address is undefined', () => {
    expect(buildGsusdToken(ChainId.SEPOLIA, undefined)).toBeUndefined();
  });

  it('returns undefined when the address is the zero-address fallback', () => {
    expect(buildGsusdToken(ChainId.SEPOLIA, ZERO_ADDRESS)).toBeUndefined();
  });

  it('builds a GSUSD token for a configured address', () => {
    const token = buildGsusdToken(ChainId.SEPOLIA, GSUSD_ADDRESS);
    expect(token).toBeDefined();
    expect(token?.symbol).toBe('GSUSD');
    expect(token?.decimals).toBe(18);
    expect(token?.chainId).toBe(ChainId.SEPOLIA);
    expect(token?.gold).toBe(false);
    expect(token?.address.toLowerCase()).toBe(GSUSD_ADDRESS.toLowerCase());
  });
});
