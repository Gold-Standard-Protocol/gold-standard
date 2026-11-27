import { createTRPCReact } from '@trpc/react-query';
import type { AppRouter } from '@goldstandard/trpc'

export const trpc = createTRPCReact<AppRouter>();