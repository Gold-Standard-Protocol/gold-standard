import { createTRPCReact } from "@trpc/react-query";
import { AppRouter } from "@goldstandard/trpc";

export const trpc = createTRPCReact<AppRouter>();