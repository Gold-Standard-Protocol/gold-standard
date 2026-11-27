import { contractKeyOf, parseDeployment } from './deployment';
import { DEPLOYMENT } from './fixtures';

const snapshot = (change: (addresses: Record<string, unknown>) => void = () => undefined, chainId: unknown = 1): string => {
  const addresses: Record<string, unknown> = { ...DEPLOYMENT.addresses, governance: '0x3625df35654E817c475655d87d097A5026C5200C' };
  change(addresses);
  return JSON.stringify({ chainId, network: 'mainnet', addresses });
};

describe('parseDeployment', () => {
  it('reads the chain and every address the rules name, checksummed', () => {
    const lower = snapshot((a) => (a['vault'] = (a['vault'] as string).toLowerCase()));
    expect(parseDeployment(lower)).toEqual(DEPLOYMENT);
  });

  it('refuses a snapshot that lacks a needed address, naming it', () => {
    expect(() => parseDeployment(snapshot((a) => delete a['timelock']))).toThrow('lacks an address for: timelock');
    expect(() => parseDeployment(snapshot((a) => (a['reserve'] = '0x12')))).toThrow('lacks an address for: reserve');
  });

  it('refuses a snapshot with no chain id, no addresses or no JSON', () => {
    expect(() => parseDeployment(snapshot(undefined, null))).toThrow('no chainId');
    expect(() => parseDeployment('{"chainId":1}')).toThrow('no addresses');
    expect(() => parseDeployment('<html>')).toThrow('not JSON');
  });
});

describe('contractKeyOf', () => {
  it('finds a contract whatever the case of the address, and nothing for a stranger', () => {
    expect(contractKeyOf(DEPLOYMENT, DEPLOYMENT.addresses.oracle.toLowerCase())).toBe('oracle');
    expect(contractKeyOf(DEPLOYMENT, '0x0000000000000000000000000000000000000001')).toBeUndefined();
  });
});
