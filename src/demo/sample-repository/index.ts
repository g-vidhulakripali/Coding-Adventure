import { detectCategory, fileNameOf, isTextCategory } from '../../core/repository/fileTypes';
import type { ProjectSource, RepositoryFile } from '../../core/repository/types';
import { SAMPLE_PROJECT_ID } from '../constants';

/**
 * Bundled DEMONSTRATION repository.
 *
 * Kept strictly separate from real repository handling: it only implements the
 * same `ProjectSource` interface a real imported project will implement. The
 * files under `./files` are ordinary source files; their paths and contents are
 * served exactly as written.
 */

export { SAMPLE_PROJECT_ID };

// Vite inlines every file under ./files as a raw string at build time.
const rawFiles = import.meta.glob<string>('./files/**/*', {
  query: '?raw',
  import: 'default',
  eager: true,
});

const PREFIX = './files/';
const encoder = new TextEncoder();

const contents = new Map<string, string>();
const files: RepositoryFile[] = [];

for (const [key, text] of Object.entries(rawFiles)) {
  const path = key.startsWith(PREFIX) ? key.slice(PREFIX.length) : key;
  contents.set(path, text);
  files.push({
    path,
    name: fileNameOf(path),
    size: encoder.encode(text).byteLength,
    category: detectCategory(path),
  });
}

export const sampleProject: ProjectSource = {
  id: SAMPLE_PROJECT_ID,
  name: 'Sample shop analytics',
  origin: 'demo',
  description: 'A small bundled Python repository: a discounted shopping total across two files and a pandas/NumPy indexing expression.',
  files,
  async readBlob(path: string): Promise<Blob> {
    const text = contents.get(path);
    if (text === undefined) throw new Error(`File not found in project: ${path}`);
    return new Blob([text]);
  },
  async readText(path: string): Promise<string> {
    const file = files.find((f) => f.path === path);
    const text = contents.get(path);
    if (!file || text === undefined) throw new Error(`File not found in project: ${path}`);
    if (!isTextCategory(file.category)) throw new Error(`File is not viewable as text: ${path}`);
    return text;
  },
};
