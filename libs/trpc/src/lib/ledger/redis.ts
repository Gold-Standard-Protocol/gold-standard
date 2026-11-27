import { Redis } from 'ioredis';
import { connectionOptions } from '../config/cacheManager';
import { redisConfig } from '../config/redisConfig';
import { reportErrorsOnce } from '../config/redisErrors';

/**
 * A lazily connected ioredis client with the cache's options: five second connect and
 * command timeouts and one retry per command, so a read during an outage rejects within
 * about a second. The ledger state needs raw ioredis because it uses hashes and
 * transactions, which the Keyv layer does not offer. The worker and the router each
 * hold their own client: the worker's uses WATCH, which is per connection.
 */
export const createLedgerRedis = (label: string): Redis => {
  const client = new Redis(connectionOptions(redisConfig));
  reportErrorsOnce(client, label, { rearmOn: client });
  return client;
};
