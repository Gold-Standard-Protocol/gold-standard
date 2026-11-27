import { ledgerToCsv, runLedgerExport } from '@goldstandard/trpc/ledger-export';

/**
 * Writes the whole usage ledger to standard output, as JSON or, with `--csv`, as CSV
 * (docs/USAGE_LEDGER.md section 7): every address with its three figures and balances as of
 * one block, in address order. It reads the same environment as the API, only reads Redis
 * and starts no server, queue or worker. Exit code 0 when the export was written, 1 when it
 * could not be.
 */
const main = async (): Promise<number> => {
  const ledger = await runLedgerExport();
  if (ledger === undefined) {
    console.error('The usage ledger is not configured in this environment, so there is nothing to export.');
    return 1;
  }
  const text = process.argv.includes('--csv') ? ledgerToCsv(ledger) : `${JSON.stringify(ledger, null, 2)}\n`;
  // Wait for the write: exiting first would cut a long export short when it is piped.
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(text, (error) => (error ? reject(error) : resolve()));
  });
  if (ledger.incomplete) {
    console.error('Note: a tracking cap was reached, so this ledger is missing some usage (docs/USAGE_LEDGER.md section 1).');
  }
  return 0;
};

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
