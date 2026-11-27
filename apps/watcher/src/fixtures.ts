import type { Deployment } from './deployment';
import type { Notification, WatchedLog } from './format';
import type { Sender } from './telegram';
import type { Logger } from './text';

/** Shared by the specs: the mainnet addresses, a recording sender and a recording logger. */
export const DEPLOYMENT: Deployment = {
  chainId: 1,
  addresses: {
    stablecoin: '0x24C3597eF975bdB565fd146f61438Ef14e15601D',
    vault: '0x9BDd28CEF1DFf26ce2401aD2A33eb521afa32146',
    oracle: '0x143BC7D142A64ed2dD3465078cc3F8d0868C1E2a',
    stabilityModule: '0x13dBf5247e20dc161D4a624614F1be06C34eeA40',
    surplusBuffer: '0x6AeCb57061f93c35cDc03Da94fCBaB8b9A9DD108',
    stabilityPool: '0x3321892E1c6bA9cccC5eCF68663BCfbb9233DC71',
    reserve: '0x506297A1d0Bbca1cf2Ad0B2AeE2896f922C71387',
    siloFactory: '0x455BE3ee69C001088Ab2A51bf5A70081574e8699',
    timelock: '0xBEaEd7bacD53EB4c37bbbD0fBD7276a825D04D4c',
  },
};

export const EXPLORER = 'https://etherscan.io';

export const hash = (n: number): string => `0x${n.toString(16).padStart(64, '0')}`;

export const mintLog = (blockNumber: number, logIndex: number, tx = blockNumber * 100 + logIndex): WatchedLog => ({
  address: DEPLOYMENT.addresses.vault,
  eventName: 'DebtMinted',
  args: { user: '0xa30072Ad3E6B5A62ba86655128985D40cb681a5f', amount: 1_551n * 10n ** 18n },
  blockNumber,
  logIndex,
  transactionHash: hash(tx),
});

export interface RecordingSender {
  send: Sender;
  sent: Notification[];
  /** Make the nth send from now (1 is the next) fail once. */
  failNext(count?: number): void;
}

export const recordingSender = (): RecordingSender => {
  const sent: Notification[] = [];
  let failures = 0;
  return {
    sent,
    failNext: (count = 1) => {
      failures = count;
    },
    send: async (notification) => {
      if (failures > 0) {
        failures -= 1;
        throw new Error('Telegram answered HTTP 502');
      }
      sent.push(notification);
    },
  };
};

export interface RecordingLogger extends Logger {
  lines: { level: string; event: string; fields?: Record<string, unknown> }[];
}

export const recordingLogger = (): RecordingLogger => {
  const lines: RecordingLogger['lines'] = [];
  return {
    lines,
    info: (event, fields) => lines.push({ level: 'info', event, fields }),
    warn: (event, fields) => lines.push({ level: 'warn', event, fields }),
    error: (event, fields) => lines.push({ level: 'error', event, fields }),
  };
};
