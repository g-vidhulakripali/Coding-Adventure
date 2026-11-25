import type { CallIndex } from '../analysis/python/callIndex';
import { computeLineStarts, positionAt, type Expr, type Module, type Stmt } from '../parser/python/ast';

/**
 * Finds the machine-learning models a file mentions, from its syntax tree and
 * imports. Nothing is run: this only tells which demo fits a piece of code.
 */

export type ModelKind = 'linear' | 'ridge' | 'mean' | 'scaler' | 'tree' | 'forest' | 'boosting' | 'mlp' | 'lstm' | 'gru' | 'pca' | 'kmeans' | 'logistic';

export interface ModelUse {
  readonly kind: ModelKind;
  /** As written, e.g. `torch.nn.LSTM`. */
  readonly name: string;
  readonly path: string;
  readonly line: number;
  readonly endLine: number;
  /** Qualified name of the function or method around it, or null for file-level code. */
  readonly within: string | null;
}

export const MODEL_LABELS: Record<ModelKind, string> = {
  linear: 'straight line',
  ridge: 'careful line (ridge)',
  mean: 'always the average',
  scaler: 'scaling',
  tree: 'decision tree',
  forest: 'random forest',
  boosting: 'boosting',
  mlp: 'neural network',
  lstm: 'LSTM',
  gru: 'GRU',
  pca: 'PCA',
  kmeans: 'k-means',
  logistic: 'yes / no curve',
};

const ROOTS = new Set(['sklearn', 'xgboost', 'lightgbm', 'catboost', 'statsmodels', 'torch', 'tensorflow', 'keras', 'scipy', 'numpy']);
const BY_NAME: Record<string, ModelKind> = {
  LinearRegression: 'linear', OLS: 'linear', WLS: 'linear', GLS: 'linear', linregress: 'linear', lstsq: 'linear', SGDRegressor: 'linear', ols: 'linear',
  Ridge: 'ridge', RidgeCV: 'ridge',
  DummyRegressor: 'mean',
  StandardScaler: 'scaler',
  DecisionTreeRegressor: 'tree', ExtraTreeRegressor: 'tree',
  RandomForestRegressor: 'forest', ExtraTreesRegressor: 'forest', BaggingRegressor: 'forest',
  GradientBoostingRegressor: 'boosting', HistGradientBoostingRegressor: 'boosting', AdaBoostRegressor: 'boosting', XGBRegressor: 'boosting', LGBMRegressor: 'boosting', CatBoostRegressor: 'boosting',
  MLPRegressor: 'mlp',
  LSTM: 'lstm', LSTMCell: 'lstm', GRU: 'gru', GRUCell: 'gru',
  PCA: 'pca', KMeans: 'kmeans', MiniBatchKMeans: 'kmeans',
  LogisticRegression: 'logistic', Logit: 'logistic',
};

export function findModels(path: string, module: Module): ModelUse[] {
  const lineStarts = computeLineStarts(module.source);
  const imports = new Map<string, string>();
  const collect = (n: unknown): void => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) {
      n.forEach(collect);
      return;
    }
    const s = n as Stmt;
    if (s.type === 'Import') for (const i of s.names) imports.set(i.asname ?? i.name.split('.')[0]!, i.asname ? i.name : i.name.split('.')[0]!);
    else if (s.type === 'ImportFrom') {
      if (s.level === 0) for (const i of s.names) imports.set(i.asname ?? i.name, `${s.module ?? ''}.${i.name}`);
    } else for (const [k, x] of Object.entries(s)) if (k !== 'span' && k !== 'headerSpan') collect(x);
  };
  collect(module.body);

  const out: ModelUse[] = [];
  const fullName = (e: Expr): string | null => {
    const parts: string[] = [];
    let node = e;
    while (node.type === 'Attribute') {
      parts.unshift(node.attr);
      node = node.value;
    }
    const root = node.type === 'Name' ? imports.get(node.id) : undefined;
    return root ? [root, ...parts].join('.') : null;
  };
  const visit = (n: unknown, within: string | null): void => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) {
      n.forEach((x) => visit(x, within));
      return;
    }
    const node = n as Expr | Stmt;
    if (node.type === 'Import' || node.type === 'ImportFrom') return;
    if (node.type === 'Name' || node.type === 'Attribute') {
      const full = fullName(node);
      const last = full?.split('.').pop() ?? '';
      if (full && ROOTS.has(full.split('.')[0]!) && Object.hasOwn(BY_NAME, last)) {
        out.push({ kind: BY_NAME[last]!, name: module.source.slice(node.span.from, node.span.to), path, line: positionAt(lineStarts, node.span.from).line, endLine: positionAt(lineStarts, node.span.to).line, within });
        return;
      }
    }
    const inner = node.type === 'FunctionDef' || node.type === 'ClassDef' ? (within ? `${within}.${node.name}` : node.name) : within;
    // Decorators and base classes are read too; a base class such as `BaseEstimator` is not a model.
    for (const [k, x] of Object.entries(node)) if (k !== 'span' && k !== 'headerSpan') visit(x, inner);
  };
  visit(module.body, null);
  return out;
}

export interface ModelPlace {
  readonly path: string;
  /** Qualified name of the running function, or null for file-level code. */
  readonly within: string | null;
  readonly line: number | null;
}

/**
 * The models that matter at one place, nearest first: on this line, in this
 * function, in functions it calls (two levels), in its class, then in this file.
 * One entry per kind.
 */
export function modelsAt(place: ModelPlace, all: ReadonlyMap<string, readonly ModelUse[]>, calls: CallIndex | null): { here: boolean; uses: readonly ModelUse[] } {
  const file = all.get(place.path) ?? [];
  const onLine = place.line === null ? [] : file.filter((u) => u.line <= place.line! && place.line! <= u.endLine);
  const inFunction = place.within === null ? [] : file.filter((u) => u.within === place.within || u.within?.startsWith(`${place.within}.`));
  const reached: ModelUse[] = [];
  if (calls && place.within !== null) {
    let level = new Set([`${place.path}::${place.within}`]);
    const seen = new Set(level);
    for (let i = 0; i < 2; i++) {
      const next = new Set<string>();
      for (const c of calls.calls) {
        if (!level.has(c.callerId) || c.target.kind !== 'internal' || seen.has(c.target.id)) continue;
        seen.add(c.target.id);
        next.add(c.target.id);
        const [path, qualname] = c.target.id.split('::') as [string, string];
        reached.push(...(all.get(path) ?? []).filter((u) => u.within === qualname || u.within?.startsWith(`${qualname}.`)));
      }
      level = next;
    }
  }
  const owner = place.within?.includes('.') ? place.within.slice(0, place.within.lastIndexOf('.')) : null;
  const inClass = owner ? file.filter((u) => u.within?.startsWith(`${owner}.`)) : [];
  const ordered = [...onLine, ...inFunction, ...reached, ...inClass, ...file];
  const uses = ordered.filter((u, i) => ordered.findIndex((x) => x.kind === u.kind) === i);
  return { here: onLine.length > 0, uses };
}
