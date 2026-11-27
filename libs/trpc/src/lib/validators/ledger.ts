import { z } from 'zod';
import { getAddress } from 'viem';

const chainId = z.union([z.literal(1), z.literal(11155111)]);

/** Any case is accepted and the checksummed form is what the procedures see. */
const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .transform((value) => getAddress(value.toLowerCase()));

export const ledgerStatusSchema = z.object({ chainId });

export const ledgerAccountSchema = z.object({ chainId, address });

export type LedgerStatusInput = z.infer<typeof ledgerStatusSchema>;
export type LedgerAccountInput = z.infer<typeof ledgerAccountSchema>;
