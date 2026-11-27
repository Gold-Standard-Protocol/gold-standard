/**
 * Work the API process must finish before it exits. The vault
 * index queue used to install its own SIGTERM handler that closed the queue and called
 * process.exit at once, cutting off requests the HTTP server was still answering. Library
 * code now registers its cleanup here and installs no signal handler; the process entry
 * (apps/api/src/main.ts) owns the signals, drains the server and runs these before it exits.
 */
type ShutdownTask = () => Promise<unknown>;

const tasks: ShutdownTask[] = [];

export const onShutdown = (task: ShutdownTask): void => {
  tasks.push(task);
};

/** Runs every registered task and waits for all of them; one that fails does not stop the rest. */
export const runShutdownTasks = async (): Promise<void> => {
  await Promise.allSettled(tasks.map((task) => task()));
};
