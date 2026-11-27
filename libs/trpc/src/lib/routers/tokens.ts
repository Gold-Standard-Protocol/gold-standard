
import { TOKEN_LIST, TokenInfo } from '@goldstandard/constants';
import { publicProcedure, router } from '../trpc';

export const tokensRouter = router({
  getAll: publicProcedure.query(async (): Promise<TokenInfo[]> => {
    return TOKEN_LIST;
  }),
});
