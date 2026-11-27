import axios from 'axios';

const owners = (chainId: number) =>
  `/trpc/vaultsRouter.owners?input=${encodeURIComponent(JSON.stringify({ chainId }))}`;

describe('api /trpc', () => {
  it('serves the vault owners query the Liquidate page depends on', async () => {
    const res = await axios.get(owners(11155111));
    expect(res.status).toBe(200);
    const data = res.data.result.data;
    expect(Array.isArray(data.owners)).toBe(true);
    for (const owner of data.owners) {
      expect(owner).toMatch(/^0x[0-9a-fA-F]{40}$/);
    }
    expect(data).toHaveProperty('lastIndexedBlock');
  });

  it('answers an unknown procedure with tRPC NOT_FOUND rather than a crash', async () => {
    const res = await axios.get('/trpc/nothing.here', { validateStatus: () => true });
    expect(res.status).toBe(404);
    expect(res.data.error.data.code).toBe('NOT_FOUND');
  });

  it('rejects malformed input with a 400', async () => {
    const res = await axios.get('/trpc/vaultsRouter.owners?input=%7B%22chainId%22%3A%22abc%22%7D', {
      validateStatus: () => true,
    });
    expect(res.status).toBe(400);
  });
});
