import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFileStateStore } from './fileStateStore';
import { parseState } from './state';
import type { WatcherState } from './state';

const STATE: WatcherState = {
  nextBlock: 26_506_000,
  delivered: ['0xabc:1'],
  thresholds: { 'reserve-coverage': { breached: true, unreadable: false, failures: 0, lastSentAt: 1_795_000_000 } },
};

describe('parseState', () => {
  it('reads back what was written', () => {
    expect(parseState(JSON.stringify(STATE))).toEqual(STATE);
  });

  it('refuses a damaged cursor, delivered list or threshold record', () => {
    expect(() => parseState(JSON.stringify({ ...STATE, nextBlock: '5' }))).toThrow('nextBlock');
    expect(() => parseState(JSON.stringify({ ...STATE, delivered: [1] }))).toThrow('delivered');
    expect(() => parseState(JSON.stringify({ ...STATE, thresholds: { x: { breached: 'yes' } } }))).toThrow('threshold');
  });
});

describe('createFileStateStore', () => {
  it('has nothing before the first save, then returns the last save and leaves no temporary file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'watcher-state-'));
    const store = createFileStateStore(join(directory, 'state.json'));
    expect(await store.load()).toBeUndefined();
    await store.save(STATE);
    await store.save({ ...STATE, nextBlock: 26_506_001 });
    expect((await store.load())?.nextBlock).toBe(26_506_001);
    expect(await readdir(directory)).toEqual(['state.json']);
    expect(JSON.parse(await readFile(join(directory, 'state.json'), 'utf8'))).toMatchObject({ nextBlock: 26_506_001 });
  });

  it('throws on a file that is there but unusable, so the cursor is never guessed', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'watcher-state-'));
    const path = join(directory, 'state.json');
    await writeFile(path, '{"nextBlock":');
    await expect(createFileStateStore(path).load()).rejects.toThrow();
  });
});
