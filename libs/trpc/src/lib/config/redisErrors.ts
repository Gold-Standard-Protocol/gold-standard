/** The surface the listener needs: an IORedis client or a BullMQ queue. */
interface ErrorEmitter {
  on(event: 'error', listener: (error: Error) => void): unknown;
}

/** An IORedis client, which emits 'ready' each time it reconnects. */
interface ReadyEmitter {
  on(event: 'ready', listener: () => void): unknown;
}

export interface ReportErrorsOptions {
  /** Re-arm the report when this emitter says the connection is back. */
  rearmOn?: ReadyEmitter;
  /** Where the line goes; stderr by default. */
  report?: (line: string) => void;
}

const writeStderr = (line: string): void => {
  console.error(line);
};

/**
 * An 'error' listener for the IORedis clients and BullMQ queues
 * that had none. Neither crashes the process without one today, but a listener makes that
 * a property of this code rather than of a library version. The first error of an outage
 * is reported and the retries after it are not, so an unreachable Redis is one line, not
 * one per reconnect; a 'ready' from `rearmOn` re-arms the report for the next outage.
 */
export const reportErrorsOnce = (
  emitter: ErrorEmitter,
  label: string,
  options: ReportErrorsOptions = {}
): void => {
  const report = options.report ?? writeStderr;
  let reported = false;
  emitter.on('error', (error: Error) => {
    if (reported) return;
    reported = true;
    report(`${label}: ${error.message}`);
  });
  options.rearmOn?.on('ready', () => {
    reported = false;
  });
};
