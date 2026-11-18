import type { ProjectSource } from '../repository/types';

/**
 * Resolves a project id to its source.
 *
 * Phase 1 knows only the bundled demo project. Phase 6 adds projects restored
 * from IndexedDB/OPFS. The demo module is loaded lazily so it never inflates
 * the initial bundle once real projects exist.
 */
export async function loadProject(projectId: string): Promise<ProjectSource | null> {
  const demo = await import('../../demo/sample-repository');
  if (projectId === demo.SAMPLE_PROJECT_ID) return demo.sampleProject;
  return null;
}

/** Picks the file to open first: an entry-point-like Python file, else the README, else the first file. */
export function defaultFileFor(project: ProjectSource): string | null {
  const paths = project.files.map((f) => f.path);
  const preferred = ['main.py', 'app.py', '__main__.py', 'README.md', 'readme.md'];
  for (const candidate of preferred) {
    if (paths.includes(candidate)) return candidate;
  }
  return project.files.find((f) => f.category === 'python')?.path ?? paths[0] ?? null;
}
