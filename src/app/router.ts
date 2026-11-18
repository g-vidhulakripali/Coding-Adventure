import { useSyncExternalStore } from 'react';
import { formatLineRange, parseLineRange, type LineRange } from '../core/source-mapping/types';

/**
 * Minimal hash-based router.
 *
 * Hash routing works on any static host (GitHub Pages, Netlify, Cloudflare
 * Pages) with no server rewrites, and keeps deep links such as
 * `#/project/sample?file=pricing.py&line=2-4` shareable. The app has only a
 * handful of routes, so a ~80-line router is preferable to a routing library.
 *
 * Note: the hash never leaves the browser, so file paths in it are not sent
 * to the hosting server.
 */

export type Route =
  | { readonly name: 'home' }
  | {
      readonly name: 'workspace';
      readonly projectId: string;
      readonly file: string | null;
      readonly lines: LineRange | null;
    }
  | { readonly name: 'not-found'; readonly path: string };

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#/, '');
  const [pathPart = '', queryPart = ''] = raw.split('?', 2) as [string?, string?];
  const path = pathPart.replace(/\/+$/, '') || '/';
  const query = new URLSearchParams(queryPart);

  if (path === '/' || path === '') return { name: 'home' };

  const workspace = /^\/project\/([^/]+)$/.exec(path);
  if (workspace) {
    return {
      name: 'workspace',
      projectId: safeDecode(workspace[1]!),
      file: query.get('file'),
      lines: parseLineRange(query.get('line')),
    };
  }

  return { name: 'not-found', path };
}

export function buildHash(route: Route): string {
  switch (route.name) {
    case 'home':
      return '#/';
    case 'workspace': {
      const query = new URLSearchParams();
      if (route.file) query.set('file', route.file);
      if (route.lines) query.set('line', formatLineRange(route.lines));
      const qs = query.toString();
      return `#/project/${encodeURIComponent(route.projectId)}${qs ? `?${qs}` : ''}`;
    }
    case 'not-found':
      return `#${route.path}`;
  }
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener('hashchange', onChange);
  return () => window.removeEventListener('hashchange', onChange);
}

const getHash = () => window.location.hash;

/** Current route; re-renders on every hash change. */
export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, getHash, () => '');
  return parseHash(hash);
}

export function navigate(route: Route, options: { replace?: boolean } = {}): void {
  const hash = buildHash(route);
  if (hash === window.location.hash) return;
  if (options.replace) {
    const url = `${window.location.pathname}${window.location.search}${hash}`;
    window.history.replaceState(window.history.state, '', url);
    // replaceState does not fire hashchange; notify subscribers ourselves.
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  } else {
    window.location.hash = hash;
  }
}
