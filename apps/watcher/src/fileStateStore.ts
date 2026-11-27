import { readFile, rename, writeFile } from 'node:fs/promises';

import { parseState } from './state';
import type { StateStore } from './state';

/**
 * The state as one JSON file. A save writes a sibling file and renames it over the old one,
 * so a crash mid-write leaves the previous state whole.
 */
export const createFileStateStore = (path: string): StateStore => ({
  load: async () => {
    let json: string;
    try {
      json = await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    return parseState(json);
  },
  save: async (state) => {
    const temporary = `${path}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    await rename(temporary, path);
  },
});
