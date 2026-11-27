import { z } from 'zod';

// The API serves whichever chains the indexer maintains. A chain with no
// indexed data returns an empty owner list rather than an error, so accepting
// both supported chain ids here is honest: the response reflects exactly what
// the indexer knows.
export const vaultOwnersSchema = z.object({
  chainId: z.union([z.literal(1), z.literal(11155111)]),
});

export type VaultOwnersInput = z.infer<typeof vaultOwnersSchema>;
