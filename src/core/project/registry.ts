import type { ProjectSource } from '../repository/types';

/**
 * Resolves a project id to its source.
 *
 * Either the bundled demo project or a project saved in this browser. The demo
 * is loaded lazily so it never inflates the initial bundle.
 */
export async function loadProject(projectId: string): Promise<ProjectSource | null> {
  const demo = await import('../../demo/sample-repository');
  if (projectId === demo.SAMPLE_PROJECT_ID) return demo.sampleProject;
  const { loadSavedProject } = await import('./storage');
  return loadSavedProject(projectId);
}

/** Picks the file to open first: an entry-point-like Python file, else the README, else the first file. */
export function defaultFileFor(project: ProjectSource): string | null {
  const paths = project.files.map((f) => f.path);
  const preferred = ['main.py', 'app.py', '__main__.py', 'README.md', 'readme.md'];
  for (const candidate of preferred) {
    if (paths.includes(candidate)) return candidate;
  }
  // Imported folders keep their own name on top (`src/app.py`): look for an entry point close to the root.
  const depth = (p: string) => p.split('/').length;
  for (const candidate of preferred) {
    const hit = paths.filter((p) => p.endsWith(`/${candidate}`)).sort((a, b) => depth(a) - depth(b))[0];
    if (hit && depth(hit) <= 3) return hit;
  }
  return project.files.find((f) => f.category === 'python')?.path ?? paths[0] ?? null;
}
