import { ledgerAccountSchema, ledgerStatusSchema } from './ledger';

const WALLET = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

describe('ledger validators', () => {
  it('accepts the two supported chains only', () => {
    expect(ledgerStatusSchema.safeParse({ chainId: 1 }).success).toBe(true);
    expect(ledgerStatusSchema.safeParse({ chainId: 11155111 }).success).toBe(true);
    expect(ledgerStatusSchema.safeParse({ chainId: 31337 }).success).toBe(false);
    expect(ledgerStatusSchema.safeParse({ chainId: '1' }).success).toBe(false);
    expect(ledgerStatusSchema.safeParse({}).success).toBe(false);
  });

  it('checksums an address given in any case', () => {
    expect(ledgerAccountSchema.parse({ chainId: 1, address: WALLET.toLowerCase() }).address).toBe(WALLET);
    expect(ledgerAccountSchema.parse({ chainId: 1, address: `0x${WALLET.slice(2).toUpperCase()}` }).address).toBe(WALLET);
    expect(ledgerAccountSchema.parse({ chainId: 1, address: WALLET }).address).toBe(WALLET);
  });

  it.each(['', '0x', '0x1234', WALLET.slice(2), `${WALLET}00`, `0x${'g'.repeat(40)}`, ` ${WALLET}`, `${WALLET}\n`, 12, null])(
    'refuses the address %p',
    (address) => {
      expect(ledgerAccountSchema.safeParse({ chainId: 1, address }).success).toBe(false);
    }
  );

  it('refuses an account request with no chain', () => {
    expect(ledgerAccountSchema.safeParse({ address: WALLET }).success).toBe(false);
  });
});
