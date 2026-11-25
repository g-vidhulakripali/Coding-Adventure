import { describe, expect, it } from 'vitest';
import { buildCallIndex } from '../analysis/python/callIndex';
import { parsePythonModule, type FunctionDef } from '../parser/python/ast';
import { neighbourhood } from '../visualisation/callMapLayout';
import { buildLineView, type LineNode } from '../visualisation/lines';
import { simulate } from './interpreter';
import { parseLiteral } from './literal';
import { exampleRows, paramHints } from './paramShapes';
import { findScenarios } from './scenarios';
import { pyRepr } from './values';

/** Python found in real projects: everything here is compared with what CPython prints. */
const run = (src: string) => simulate({ sources: new Map([['a.py', src]]) }, { kind: 'script', path: 'a.py' });

describe('everyday Python', () => {
  it.each([
    ['comprehensions', 'xs = [1, 2, 3, 4]\nprint([x * 2 for x in xs if x % 2 == 0], {x: x ** 2 for x in xs[:2]}, sorted({x % 2 for x in xs}), sum(x for x in xs))', ['[4, 8] {1: 1, 2: 4} [0, 1] 10']],
    ['f-strings', 'name = "cell"\nv = 3.14159\nprint(f"{name!r} {v:.2f} {v:>8.1f}|{1234567:,} {0.256:.1%}")', ["'cell' 3.14      3.1|1,234,567 25.6%"]],
    ['dictionaries change in place', 'd = {"a": 1}\ne = d\ne["b"] = 2\nd["a"] += 5\nd.update({"c": 3})\nprint(e, d.get("z", 0), list(d.items())[0])', ["{'a': 6, 'b': 2, 'c': 3} 0 ('a', 6)"]],
    ['lists change in place', 'a = [3, 1, 2]\nb = a\nb.append(0)\na.sort(reverse=True)\ndel b[0]\nprint(a, a is not None, b[-1], a[::-1])', ['[2, 1, 0] True 0 [0, 1, 2]']],
    ['unpacking', 'first, *rest = [1, 2, 3]\n(a, b), c = (1, 2), 3\nprint(first, rest, a + b + c)', ['1 [2, 3] 6']],
    ['functions with defaults, *args and **kwargs', 'def f(a, *more, scale=2, **other):\n    return a * scale + sum(more) + len(other)\nprint(f(1, 2, 3, scale=10, z=1), f(*[1, 2], **{"scale": 3}))', ['16 5']],
    ['closures, lambdas and sort keys', 'def adder(n):\n    def add(x):\n        return x + n\n    return add\nadd5 = adder(5)\nwords = ["pear", "fig", "banana"]\nprint(add5(1), sorted(words, key=len), max(words, key=lambda w: len(w)), list(map(lambda w: w.upper(), words))[0])', ["6 ['fig', 'pear', 'banana'] banana PEAR"]],
    ['errors that are caught', 'class Bad(ValueError):\n    pass\ndef f(x):\n    try:\n        if x > 1:\n            raise Bad("too big")\n        return 1 / x\n    except ZeroDivisionError:\n        return "zero"\n    except ValueError as err:\n        return str(err)\n    finally:\n        print("done")\nprint(f(0), f(5))', ['done', 'done', 'zero too big']],
    ['dataclasses', 'from dataclasses import dataclass\n@dataclass(frozen=True)\nclass P:\n    x: float\n    y: float = 2.0\np = P(1.5)\nprint(p.x + p.y)', ['3.5']],
    ['nonlocal and global', 'n = 0\ndef count():\n    global n\n    n += 1\ncount()\ncount()\nprint(n)', ['2']],
    ['loops with else, enumerate and zip', 'for i, (a, b) in enumerate(zip("ab", [1, 2])):\n    print(i, a, b)\nelse:\n    print("end")', ['0 a 1', '1 b 2', 'end']],
    ['text methods and slices', 's = "part_04_ab"\nprint(s.split("_")[1], s[5:7], s.replace("_", " ").title(), s.startswith("part"), ", ".join(["a", "b"]))', ['04 04 Part 04 Ab True a, b']],
    ['tables', 'import pandas as pd\nimport numpy as np\ndf = pd.DataFrame({"a": [1, 2, 3], "g": ["x", "y", "x"]})\ndf["b"] = df["a"] * 2\npicked = df[df["g"] == "x"]\nprint(picked["b"].sum(), df.loc[df["a"] > 1, "b"].iloc[0], len(picked), np.isclose(0.1 + 0.2, 0.3))', ['8 4 2 True']],
  ])('%s', (_name, src, expected) => {
    const t = run(src);
    expect(t.stop).toBeNull();
    expect(t.console).toEqual(expected);
  });

  it('raises like Python when nothing catches it', () => {
    expect(run('d = {"a": 1}\nprint(d["b"])').stop?.message).toBe("KeyError: 'b'");
    expect(run('assert 1 > 2, "no"').stop?.message).toBe('AssertionError: no');
    expect(run('x = None\nprint(f"{x:.2f}")').stop?.message).toBe('TypeError: unsupported format string passed to NoneType.__format__');
  });

  it('does not trust a comprehension whose inside depends on a decision that is not known', () => {
    const t = run('import requests\ndef f(x):\n    if requests.get(x):\n        return 1\n    return 2\nprint([f(x) for x in [1, 2]])');
    expect(t.console).toEqual(['?']);
  });

  it('finds packages from any parent folder, like running from the project root', () => {
    const sources = new Map([
      ['repo/src/constants.py', 'WEIGHT = "weight_kg"\n'],
      ['repo/src/step/engine.py', 'from src import constants as K\ndef name():\n    return K.WEIGHT\n'],
    ]);
    const t = simulate({ sources }, { kind: 'function', path: 'repo/src/step/engine.py', name: 'name', args: new Map() });
    expect(pyRepr(t.steps.find((s) => s.kind === 'return')!.output!)).toBe("'weight_kg'");
  });

  it('shows with, try and except as containers', () => {
    const src = 'def f():\n    try:\n        x = 1 / 0\n    except ZeroDivisionError:\n        x = 5\n    return x\nf()\n';
    const t = run(src);
    const i = t.steps.findIndex((s) => s.title.startsWith('Caught'));
    const view = buildLineView(t, i, new Map([['a.py', src]]))!;
    expect(view.nodes.map((n: LineNode) => `${n.label ?? 'line'}:${n.status}`)).toEqual(['try:done', 'except:current', 'line:pending']);
  });
});

describe('inputs read from the code', () => {
  const constants = 'HEIGHT_COL = "height_cm"\n';
  const src = `from src import constants as K
def by_key(proj):
    return proj["size"] * proj.get("hours", 1)
def table(df, limit=3):
    part = df[df["phase"] == "idle"]
    return part[K.HEIGHT_COL].mean()
def plain(x, *rest, **more):
    return x
`;
  const modules = new Map([
    ['src/constants.py', parsePythonModule(constants)],
    ['src/a.py', parsePythonModule(src)],
  ]);
  const def = (name: string) => modules.get('src/a.py')!.body.find((s): s is FunctionDef => s.type === 'FunctionDef' && s.name === name)!;

  it('knows tables, dictionaries and plain values apart, and follows constants', () => {
    expect(paramHints(def('by_key'), 'src/a.py', modules).get('proj')).toMatchObject({ shape: 'dict', keys: ['size', 'hours'] });
    const df = paramHints(def('table'), 'src/a.py', modules).get('df')!;
    expect(df).toMatchObject({ shape: 'table', keys: ['phase'] });
    expect(exampleRows(df, 2)).toBe('phase\nidle\nidle');
    expect(paramHints(def('plain'), 'src/a.py', modules).get('x')!.shape).toBe('value');
  });

  it('offers every function, also private ones and ones with *args', () => {
    expect(findScenarios('src/a.py', modules.get('src/a.py')!).filter((s) => s.kind === 'function').map((s) => s.label)).toEqual(['Call by_key(proj)', 'Call table(df, limit)', 'Call plain(x, rest, more)']);
  });

  it('reads dictionaries and unknowns typed by the user', () => {
    const r = parseLiteral('{"a": 1.5, "b": [1, ?]}');
    expect(r.ok && pyRepr(r.value)).toBe("{'a': 1.5, 'b': [1, ?]}");
    expect(parseLiteral('{"a" 1}').ok).toBe(false);
  });
});

describe('large projects', () => {
  it('focuses the call map on one function and its neighbours', () => {
    const many = Array.from({ length: 80 }, (_, i) => `def f${i}():\n    ${i < 79 ? `f${i + 1}()` : 'pass'}\n`).join('');
    const index = buildCallIndex(new Map([['a.py', many]]));
    expect([...neighbourhood(index, 'a.py::f10')].sort()).toEqual(['a.py::f10', 'a.py::f11', 'a.py::f12', 'a.py::f9']);
  });
});
