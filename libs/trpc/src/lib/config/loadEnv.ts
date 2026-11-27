import dotenv from 'dotenv';

let loaded = false;

/**
 * Loads libs/trpc/.env, the local development file, into process.env once. A variable the
 * environment already sets always wins, so production, which injects its variables and
 * ships no such file, is unaffected. A missing file is fine; any other load failure is
 * reported so a dormant indexer or a localhost Redis is diagnosable.
 *
 * Every module that reads the environment at load calls this first: the Redis settings used to be
 * parsed before the indexer's config had loaded
 * the file, so a REDIS_URL or REDIS_NAMESPACE kept there was ignored in development.
 */
export const loadLocalEnv = (): void => {
  if (loaded) return;
  loaded = true;
  const result = dotenv.config({ path: `${process.cwd()}/libs/trpc/.env` });
  if (result.error && (result.error as NodeJS.ErrnoException).code !== 'ENOENT') {
    console.warn(`Failed to load libs/trpc/.env: ${result.error.message}`);
  }
};
