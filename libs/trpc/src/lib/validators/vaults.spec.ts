import { vaultOwnersSchema } from './vaults';

describe('vaultOwnersSchema', () => {
  it('accepts the Sepolia chain id', () => {
    const result = vaultOwnersSchema.safeParse({ chainId: 11155111 });
    expect(result.success).toBe(true);
  });

  it('accepts the mainnet chain id', () => {
    const result = vaultOwnersSchema.safeParse({ chainId: 1 });
    expect(result.success).toBe(true);
  });

  it('rejects an unsupported chain id', () => {
    const result = vaultOwnersSchema.safeParse({ chainId: 5 });
    expect(result.success).toBe(false);
  });

  it('rejects a string chain id', () => {
    const result = vaultOwnersSchema.safeParse({ chainId: '11155111' });
    expect(result.success).toBe(false);
  });

  it('rejects missing input', () => {
    const result = vaultOwnersSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});
