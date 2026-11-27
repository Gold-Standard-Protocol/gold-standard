import { parseIndexerConfig } from './config';

const VALID_ENV = {
  SEPOLIA_RPC_URL: 'https://sepolia.example.org/rpc',
  GOLD_VAULT_ADDRESS: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
  GOLD_VAULT_DEPLOY_BLOCK: '7654321',
};

describe('parseIndexerConfig', () => {
  it('returns a config with a checksummed address and bigint deploy block', () => {
    const result = parseIndexerConfig(VALID_ENV);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.rpcUrl).toBe(VALID_ENV.SEPOLIA_RPC_URL);
      expect(result.config.goldVaultAddress).toBe(
        '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
      );
      expect(result.config.deployBlock).toBe(7654321n);
    }
  });

  it('returns not ok when the RPC URL is missing', () => {
    const result = parseIndexerConfig({
      ...VALID_ENV,
      SEPOLIA_RPC_URL: undefined,
    });
    expect(result.ok).toBe(false);
  });

  it('treats empty strings as missing values', () => {
    const result = parseIndexerConfig({
      ...VALID_ENV,
      GOLD_VAULT_DEPLOY_BLOCK: '   ',
    });
    expect(result.ok).toBe(false);
  });

  it('returns not ok for the zero address', () => {
    const result = parseIndexerConfig({
      ...VALID_ENV,
      GOLD_VAULT_ADDRESS: '0x0000000000000000000000000000000000000000',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('zero address');
    }
  });

  it('returns not ok for a malformed address', () => {
    const result = parseIndexerConfig({
      ...VALID_ENV,
      GOLD_VAULT_ADDRESS: '0x1234',
    });
    expect(result.ok).toBe(false);
  });

  it('returns not ok for a non-URL RPC value', () => {
    const result = parseIndexerConfig({
      ...VALID_ENV,
      SEPOLIA_RPC_URL: 'not a url',
    });
    expect(result.ok).toBe(false);
  });

  it('returns not ok for a negative deploy block', () => {
    const result = parseIndexerConfig({
      ...VALID_ENV,
      GOLD_VAULT_DEPLOY_BLOCK: '-5',
    });
    expect(result.ok).toBe(false);
  });

  it('leaves the log window alone unless INDEXER_MAX_BLOCK_RANGE is set', () => {
    const unset = parseIndexerConfig(VALID_ENV);
    expect(unset.ok && 'maxBlockRange' in unset.config).toBe(false);
    const blank = parseIndexerConfig({ ...VALID_ENV, INDEXER_MAX_BLOCK_RANGE: '  ' });
    expect(blank.ok && 'maxBlockRange' in blank.config).toBe(false);
    const ten = parseIndexerConfig({ ...VALID_ENV, INDEXER_MAX_BLOCK_RANGE: '10' });
    expect(ten.ok && ten.config.maxBlockRange).toBe(10n);
    const full = parseIndexerConfig({ ...VALID_ENV, INDEXER_MAX_BLOCK_RANGE: '10000' });
    expect(full.ok && full.config.maxBlockRange).toBe(10_000n);
  });

  it('refuses an INDEXER_MAX_BLOCK_RANGE of zero, a fraction, a word or more than 10,000', () => {
    for (const value of ['0', '-3', '2.5', 'ten', '10001']) {
      expect(parseIndexerConfig({ ...VALID_ENV, INDEXER_MAX_BLOCK_RANGE: value }).ok).toBe(false);
    }
  });

  it('defaults the chain id to Sepolia when INDEXER_CHAIN_ID is unset', () => {
    const result = parseIndexerConfig(VALID_ENV);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.chainId).toBe(11155111);
    }
  });

  it('selects mainnet when INDEXER_CHAIN_ID is 1', () => {
    const result = parseIndexerConfig({
      ...VALID_ENV,
      INDEXER_CHAIN_ID: '1',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.chainId).toBe(1);
    }
  });

  it('returns not ok for an unsupported INDEXER_CHAIN_ID', () => {
    const result = parseIndexerConfig({
      ...VALID_ENV,
      INDEXER_CHAIN_ID: '5',
    });
    expect(result.ok).toBe(false);
  });

  it('treats a whitespace-only INDEXER_CHAIN_ID as unset', () => {
    const result = parseIndexerConfig({
      ...VALID_ENV,
      INDEXER_CHAIN_ID: '   ',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.chainId).toBe(11155111);
    }
  });
});
