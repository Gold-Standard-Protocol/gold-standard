import { onShutdown, runShutdownTasks } from './shutdown';

describe('shutdown tasks', () => {
  it('runs every registered task and waits for all of them, a failing one included', async () => {
    const finished: string[] = [];
    onShutdown(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      finished.push('slow');
    });
    onShutdown(async () => {
      throw new Error('queue already closed');
    });
    onShutdown(async () => {
      finished.push('fast');
    });

    await expect(runShutdownTasks()).resolves.toBeUndefined();

    expect(finished.sort()).toEqual(['fast', 'slow']);
  });
});
