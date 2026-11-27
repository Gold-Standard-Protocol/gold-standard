import { EventEmitter } from 'events';

import { StartExecutorSchema } from './schema';

// The executor orchestrates long-running `nx serve` dev servers, so we mock
// child_process.exec to avoid spawning real processes (and to avoid the
// backend Promise that, by design, never resolves while servers run).
const execMock = jest.fn();

jest.mock('child_process', () => ({
  exec: (...args: unknown[]) => execMock(...args),
}));

// chalk is ESM/colour-only here; stub it so output formatting is deterministic.
jest.mock('chalk', () => ({
  bgGreen: (value: string) => value,
  bgBlue: (value: string) => value,
}));

import executor from './executor';

function createFakeChildProcess() {
  const cp = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: jest.Mock;
  };
  cp.stdout = new EventEmitter();
  cp.stderr = new EventEmitter();
  cp.kill = jest.fn();
  return cp;
}

describe('Start Executor', () => {
  const options: StartExecutorSchema = {
    frontendProject: 'dapp',
    backendProject: 'api',
  };

  beforeEach(() => {
    execMock.mockReset();
    execMock.mockImplementation(() => createFakeChildProcess());
  });

  it('starts the backend serve command with the configured project', () => {
    // runExecutor awaits a deliberately non-resolving server Promise, so we do
    // not await it here; we only assert the synchronous spawn side effect.
    void executor(options);

    expect(execMock).toHaveBeenCalledWith(
      'npx nx serve api',
      expect.objectContaining({ maxBuffer: expect.any(Number) })
    );
  });

  it('starts the frontend serve command once the backend reports "Listening"', () => {
    const backendCp = createFakeChildProcess();
    execMock.mockImplementationOnce(() => backendCp);

    void executor(options);

    backendCp.stdout.emit('data', 'Backend Listening on port 3000');

    expect(execMock).toHaveBeenCalledWith(
      'npx nx serve dapp',
      expect.objectContaining({ maxBuffer: expect.any(Number) })
    );
  });
});
