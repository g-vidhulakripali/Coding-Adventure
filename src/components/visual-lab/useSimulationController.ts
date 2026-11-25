import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { callIndexSteps, type CallIndex } from '../../core/analysis/python/callIndex';
import { parsePythonModule, type Module } from '../../core/parser/python/ast';
import { csvToDataFrame } from '../../core/simulation/csv';
import { exampleRows, paramHints, type ParamHint, type ParamShape } from '../../core/simulation/paramShapes';
import { simulate, type SimulationEntry } from '../../core/simulation/interpreter';
import { parseLiteral } from '../../core/simulation/literal';
import { definitionOf, findEditableInputs, findScenarios, type EditableInput, type ScenarioOption } from '../../core/simulation/scenarios';
import type { Step, Trace } from '../../core/simulation/trace';
import { pyRepr, unknown, type PyValue } from '../../core/simulation/values';

export type PlaybackSpeed = 0.5 | 1 | 2;

export interface ParamInput {
  /** Unique key: `init:<name>` (values to make the object) or `call:<name>` (the function/method's own). */
  readonly key: string;
  readonly group: 'init' | 'call';
  readonly name: string;
  readonly text: string;
  readonly value: PyValue | null;
  readonly error: string | null;
  /** What the code expects: a plain value, a table, or a dictionary. */
  readonly shape: ParamShape;
  /** For dictionaries: one small box per key the code uses. */
  readonly fields: ReadonlyArray<{ readonly key: string; readonly text: string }>;
  /** For tables and dictionaries: columns / keys the code uses. */
  readonly keys: readonly string[];
}

export interface InputField {
  readonly input: EditableInput;
  readonly text: string;
  readonly error: string | null;
  readonly edited: boolean;
}

export interface SimulationController {
  readonly ready: boolean;
  /** Original Python sources (for the line-by-line view). */
  readonly sources: ReadonlyMap<string, string> | null;
  readonly scenarios: readonly ScenarioOption[];
  readonly scenario: ScenarioOption | null;
  readonly selectScenario: (id: string) => void;
  /** Scenario for the file open in the code panel, when it differs from the active one. */
  readonly suggestedScenario: ScenarioOption | null;
  readonly inputFields: readonly InputField[];
  readonly setInputText: (key: string, text: string) => void;
  readonly commitInput: (key: string) => void;
  readonly params: readonly ParamInput[];
  readonly setParamText: (key: string, text: string) => void;
  readonly commitParam: (key: string) => void;
  /** Types one entry of a dictionary parameter (kept as text until committed). */
  readonly setParamField: (key: string, field: string, text: string) => void;
  /** Fills a table or dictionary with made-up example values. */
  readonly fillExample: (key: string) => void;
  /** Switches the assumed answer of a decision that is not known. */
  readonly choose: (key: string, taken: boolean) => void;
  /** Moves past calls: to the next operation of the same (or an outer) function. */
  readonly stepOver: () => void;
  /** Whether the current run goes through this file. */
  readonly touches: (path: string) => boolean;
  readonly selectScenarioFor: (path: string) => void;
  /** Selects the function or method defined at this line. */
  readonly selectScenarioAt: (path: string, line: number) => void;
  readonly resetInputs: () => void;
  readonly missingParams: readonly string[];
  /** A data file the code reads that is not in the project: the user can paste sample rows for it. */
  readonly missingData: { readonly path: string; readonly text: string; readonly supplied: boolean } | null;
  readonly setDataText: (path: string, text: string) => void;
  readonly commitData: (path: string) => void;
  readonly trace: Trace | null;
  readonly step: Step | null;
  readonly stepIndex: number;
  readonly goTo: (index: number) => void;
  readonly next: () => void;
  readonly prev: () => void;
  readonly restart: () => void;
  readonly playing: boolean;
  readonly togglePlay: () => void;
  readonly speed: PlaybackSpeed;
  readonly setSpeed: (speed: PlaybackSpeed) => void;
  readonly callIndex: CallIndex | null;
  /** Increments whenever the user moves to a step (used to decide when to follow execution in the code panel). */
  readonly navigationSerial: number;
}

/** Base time per step at 1× speed, including the animation. */
export const STEP_INTERVAL_MS = 1800;

const NO_MODULES: ReadonlyMap<string, Module> = new Map();

interface ParamSpec {
  readonly key: string;
  readonly group: 'init' | 'call';
  readonly name: string;
  readonly defaultValue: PyValue | null;
}

function paramSpecs(scenario: ScenarioOption | null): ParamSpec[] {
  if (!scenario || scenario.kind === 'script') return [];
  const call = scenario.params.map((p) => ({ key: `call:${p.name}`, group: 'call' as const, name: p.name, defaultValue: p.defaultValue }));
  if (scenario.kind === 'function') return call;
  return [...scenario.initParams.map((p) => ({ key: `init:${p.name}`, group: 'init' as const, name: p.name, defaultValue: p.defaultValue })), ...call];
}

function defaultsFor(scenario: ScenarioOption | null): Map<string, PyValue> {
  const defaults = new Map<string, PyValue>();
  for (const p of paramSpecs(scenario)) if (p.defaultValue) defaults.set(p.key, p.defaultValue);
  return defaults;
}

export function useSimulationController(
  sources: ReadonlyMap<string, string> | null,
  dataFiles: ReadonlyMap<string, string> | null,
  currentFile: string | null,
): SimulationController {
  // Analysis runs in short slices, so a large project does not freeze the page.
  const [modules, setModules] = useState<ReadonlyMap<string, Module>>(NO_MODULES);
  const [callIndex, setCallIndex] = useState<CallIndex | null>(null);
  useEffect(() => {
    setModules(NO_MODULES);
    setCallIndex(null);
    if (!sources) return;
    let cancelled = false;
    void (async () => {
      let slice = performance.now();
      const pause = async () => {
        if (performance.now() - slice < 24) return;
        await new Promise((r) => setTimeout(r));
        slice = performance.now();
      };
      const map = new Map<string, Module>();
      for (const [path, text] of sources) {
        map.set(path, parsePythonModule(text));
        await pause();
        if (cancelled) return;
      }
      setModules(map);
      const steps = callIndexSteps(sources);
      for (;;) {
        const r = steps.next();
        if (r.done) {
          setCallIndex(r.value);
          return;
        }
        await pause();
        if (cancelled) return;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sources]);

  const allScenarios = useMemo(() => {
    const out: ScenarioOption[] = [];
    for (const [path, mod] of modules) out.push(...findScenarios(path, mod));
    return out;
  }, [modules]);

  // Scripts from the whole project, plus functions and class methods of the open file.
  const scenarios = useMemo(
    () => allScenarios.filter((s) => s.kind === 'script' || s.path === currentFile),
    [allScenarios, currentFile],
  );

  const [scenarioId, setScenarioId] = useState<string | null>(null);
  const scenario = allScenarios.find((s) => s.id === scenarioId) ?? null;

  // Pick a default once sources are ready: this file's script; else a script that calls into this
  // file (from the static call index); else a conventional entry point; else this file's first function.
  useEffect(() => {
    if (scenarioId || allScenarios.length === 0 || !callIndex) return;
    const scripts = allScenarios.filter((s) => s.kind === 'script' && s.isProgram);
    const here = allScenarios.filter((s) => s.path === currentFile);
    const callsIntoCurrent = (path: string) =>
      callIndex?.calls.some((c) => c.callerId === `${path}::<module>` && c.target.kind === 'internal' && c.target.id.startsWith(`${currentFile}::`)) ?? false;
    const entryRank = (path: string) => {
      const name = path.split('/').pop() ?? path;
      const preferred = ['main.py', 'app.py', '__main__.py', 'run.py', 'cli.py'].indexOf(name);
      return (preferred === -1 ? 10 : preferred) + path.split('/').length;
    };
    const pick =
      scripts.find((s) => s.path === currentFile) ??
      scripts.find((s) => callsIntoCurrent(s.path)) ??
      // In a project of many files, the open file's own function is the natural start.
      (modules.size > 12 ? here.find((s) => s.kind !== 'script') : undefined) ??
      here.find((s) => s.kind === 'script') ??
      [...scripts].sort((a, b) => entryRank(a.path) - entryRank(b.path))[0] ??
      allScenarios.find((s) => s.path === currentFile) ??
      null;
    if (pick) setScenarioId(pick.id);
  }, [allScenarios, currentFile, scenarioId, callIndex, modules]);

  const bestFor = useCallback(
    (path: string) => {
      const here = allScenarios.filter((s) => s.path === path);
      return here.find((s) => s.kind === 'script' && s.isProgram) ?? here.find((s) => s.kind !== 'script') ?? here[0] ?? null;
    },
    [allScenarios],
  );
  const suggestedScenario = useMemo(() => (!currentFile || scenario?.path === currentFile ? null : bestFor(currentFile)), [bestFor, currentFile, scenario]);
  const selectScenarioFor = useCallback(
    (path: string) => {
      const best = bestFor(path);
      if (best) setScenarioId(best.id);
    },
    [bestFor],
  );
  const selectScenarioAt = useCallback(
    (path: string, line: number) => {
      const hit = allScenarios.find((s) => s.path === path && s.kind !== 'script' && s.line === line);
      if (hit) setScenarioId(hit.id);
    },
    [allScenarios],
  );

  // ---- Inputs ----------------------------------------------------------------
  const editableInputs = useMemo(() => {
    if (!scenario || scenario.kind !== 'script') return [];
    const mod = modules.get(scenario.path);
    return mod ? findEditableInputs(scenario.path, mod) : [];
  }, [scenario, modules]);

  const [texts, setTexts] = useState<Record<string, string>>({});
  const [overrides, setOverrides] = useState<Map<string, PyValue>>(new Map());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [paramTexts, setParamTexts] = useState<Record<string, string>>({});
  const [paramValues, setParamValues] = useState<Map<string, PyValue>>(new Map());
  const [paramFields, setParamFields] = useState<Record<string, Record<string, string>>>({});
  const [choices, setChoices] = useState<ReadonlyMap<string, boolean>>(new Map());
  const choose = useCallback((key: string, taken: boolean) => setChoices((c) => new Map(c).set(key, taken)), []);

  // What the code does with each parameter (which columns, which keys).
  const hints = useMemo(() => {
    const out = new Map<string, ParamHint>();
    const mod = scenario ? modules.get(scenario.path) : undefined;
    if (!scenario || !mod) return out;
    for (const [group, init] of [['call', false], ['init', true]] as const) {
      const def = definitionOf(scenario, mod, init);
      if (def && (!init || scenario.kind === 'method')) for (const [name, h] of paramHints(def, scenario.path, modules)) out.set(`${group}:${name}`, h);
    }
    return out;
  }, [scenario, modules]);

  // Reset per scenario.
  useEffect(() => {
    setTexts({});
    setOverrides(new Map());
    setErrors({});
    setParamTexts({});
    setParamFields({});
    setChoices(new Map());
    setParamValues(defaultsFor(scenario));
  }, [scenario?.id]);

  const inputFields: InputField[] = editableInputs.map((input) => ({
    input,
    text: texts[input.key] ?? pyRepr(overrides.get(input.key) ?? input.original),
    error: errors[input.key] ?? null,
    edited: overrides.has(input.key),
  }));

  const setInputText = useCallback((key: string, text: string) => setTexts((t) => ({ ...t, [key]: text })), []);
  const commitInput = useCallback(
    (key: string) => {
      const text = texts[key];
      if (text === undefined) return;
      const parsed = parseLiteral(text);
      if (!parsed.ok) {
        setErrors((e) => ({ ...e, [key]: parsed.error }));
        return;
      }
      setErrors(({ [key]: _removed, ...rest }) => rest);
      setOverrides((prev) => new Map(prev).set(key, parsed.value));
      setTexts(({ [key]: _done, ...rest }) => rest);
    },
    [texts],
  );

  const specs = paramSpecs(scenario);
  const params: ParamInput[] = specs.map((p) => {
    const hint = hints.get(p.key);
    // A parameter with a default is a plain box unless the code clearly uses it as a table.
    const shape: ParamShape = !hint || (p.defaultValue && hint.shape === 'dict') ? 'value' : hint.shape === 'dict' && hint.keys.length === 0 ? 'value' : hint.shape;
    const value = paramValues.get(p.key) ?? null;
    const keys = hint?.keys ?? [];
    return {
      key: p.key,
      group: p.group,
      name: p.name,
      shape,
      keys,
      fields: shape === 'dict' ? keys.map((k) => ({ key: k, text: paramFields[p.key]?.[k] ?? '' })) : [],
      text: paramTexts[p.key] ?? (shape === 'table' ? keys.join(',') : value ? pyRepr(value) : ''),
      value,
      error: errors[`param:${p.key}`] ?? null,
    };
  });
  const shapeOf = (key: string) => params.find((p) => p.key === key)?.shape ?? 'value';
  const setValue = (key: string, value: PyValue | null, error: string | null = null) => {
    const errKey = `param:${key}`;
    setErrors(({ [errKey]: _old, ...rest }) => (error ? { ...rest, [errKey]: error } : rest));
    if (error) return;
    setParamValues((prev) => {
      const next = new Map(prev);
      if (value) next.set(key, value);
      else next.delete(key);
      return next;
    });
  };
  const commitTable = (key: string, text: string) => {
    if (text.trim().split('\n').length < 2) {
      setValue(key, null);
      return;
    }
    try {
      setValue(key, csvToDataFrame(text.trim(), 'This table'));
    } catch (err) {
      setValue(key, null, err instanceof Error ? err.message : String(err));
    }
  };
  const commitFields = (key: string, fields: Record<string, string>) => {
    const entries: Array<readonly [PyValue, PyValue]> = [];
    const keys = hints.get(key)?.keys ?? [];
    let given = false;
    for (const k of keys) {
      const text = (fields[k] ?? '').trim();
      const parsed = text === '' ? { ok: true as const, value: unknown(k) } : parseLiteral(text);
      if (!parsed.ok) {
        setValue(key, null, `${k}: ${parsed.error}`);
        return;
      }
      if (text !== '') given = true;
      entries.push([{ t: 'str', v: k }, parsed.value]);
    }
    setValue(key, given ? { t: 'dict', entries } : null);
  };
  const setParamField = useCallback((key: string, field: string, text: string) => setParamFields((f) => ({ ...f, [key]: { ...f[key], [field]: text } })), []);
  const fillExample = (key: string) => {
    const hint = hints.get(key);
    if (!hint) return;
    if (shapeOf(key) === 'table') {
      const text = exampleRows(hint);
      setParamTexts((t) => ({ ...t, [key]: text }));
      commitTable(key, text);
    } else {
      const fields = Object.fromEntries(hint.keys.map((k, i) => [k, hint.compared.get(k)?.[0] !== undefined ? pyRepr({ t: 'str', v: hint.compared.get(k)![0]! }) : `${i + 1}.0`]));
      setParamFields((f) => ({ ...f, [key]: fields }));
      commitFields(key, fields);
    }
  };
  const setParamText = useCallback((key: string, text: string) => setParamTexts((t) => ({ ...t, [key]: text })), []);
  const commitPlain = useCallback(
    (key: string) => {
      const text = paramTexts[key];
      if (text === undefined) return;
      const errKey = `param:${key}`;
      if (text.trim() === '') {
        setParamValues((prev) => {
          const next = new Map(prev);
          next.delete(key);
          return next;
        });
        return;
      }
      const parsed = parseLiteral(text);
      if (!parsed.ok) {
        setErrors((e) => ({ ...e, [errKey]: parsed.error }));
        return;
      }
      setErrors(({ [errKey]: _removed, ...rest }) => rest);
      setParamValues((prev) => new Map(prev).set(key, parsed.value));
      setParamTexts(({ [key]: _done, ...rest }) => rest);
    },
    [paramTexts],
  );

  const commitParam = (key: string) => {
    const shape = shapeOf(key);
    if (shape === 'dict') commitFields(key, paramFields[key] ?? {});
    else if (shape === 'table') {
      if (paramTexts[key] !== undefined) commitTable(key, paramTexts[key]);
    } else commitPlain(key);
  };

  // Sample rows the user typed for data files the project does not contain.
  const [dataTexts, setDataTexts] = useState<Record<string, string>>({});
  const [dataOverrides, setDataOverrides] = useState<Map<string, string>>(new Map());
  const setDataText = useCallback((path: string, text: string) => setDataTexts((t) => ({ ...t, [path]: text })), []);
  const commitData = useCallback(
    (path: string) => {
      const text = dataTexts[path];
      if (text === undefined || text.trim() === '') return;
      setDataOverrides((prev) => new Map(prev).set(path, text));
    },
    [dataTexts],
  );
  const allDataFiles = useMemo(() => {
    const merged = new Map(dataFiles ?? []);
    for (const [path, text] of dataOverrides) merged.set(path, text);
    return merged;
  }, [dataFiles, dataOverrides]);

  const resetInputs = useCallback(() => {
    setTexts({});
    setOverrides(new Map());
    setErrors({});
    setParamTexts({});
    setParamFields({});
    setChoices(new Map());
    setParamValues(defaultsFor(scenario));
  }, [scenario]);

  const missingParams = specs.filter((p) => !paramValues.has(p.key)).map((p) => p.name);

  const pick = (group: 'init' | 'call') =>
    new Map(specs.filter((p) => p.group === group && paramValues.has(p.key)).map((p) => [p.name, paramValues.get(p.key)!] as const));

  // ---- Trace -------------------------------------------------------------------
  const trace = useMemo(() => {
    if (!sources || !scenario) return null;
    let entry: SimulationEntry;
    // Arguments without a value stay unknown (`?`): the function can be read right away.
    if (scenario.kind === 'script') entry = { kind: 'script', path: scenario.path };
    else if (scenario.kind === 'method') {
      entry = { kind: 'method', path: scenario.path, className: scenario.className, method: scenario.method, initArgs: pick('init'), args: pick('call') };
    } else entry = { kind: 'function', path: scenario.path, name: scenario.name, args: pick('call') };
    return simulate({ sources, dataFiles: allDataFiles }, entry, { overrides, choices });
  }, [sources, allDataFiles, scenario, overrides, paramValues, choices]); // pick/specs derive from scenario + paramValues

  const missingPath = trace?.stop?.kind === 'missing-data' ? trace.stop.path ?? null : null;
  const suppliedPath = [...dataOverrides.keys()].find((p) => trace?.steps.some((st) => st.explanation.what.includes(p))) ?? null;
  const dataPath = missingPath ?? suppliedPath;
  const missingData = dataPath ? { path: dataPath, text: dataTexts[dataPath] ?? dataOverrides.get(dataPath) ?? '', supplied: dataOverrides.has(dataPath) } : null;

  // ---- Playback ----------------------------------------------------------------
  const [stepIndex, setStepIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<PlaybackSpeed>(1);
  const [navigationSerial, setNavigationSerial] = useState(0);
  const total = trace?.steps.length ?? 0;

  // New scenario → start at the beginning; new inputs → stay on the same step if it still exists.
  useEffect(() => {
    setStepIndex(0);
    setPlaying(false);
  }, [scenario?.id]);
  useEffect(() => {
    setStepIndex((i) => Math.min(i, Math.max(0, total - 1)));
  }, [total]);

  const goTo = useCallback(
    (index: number) => {
      setStepIndex(Math.max(0, Math.min(index, total - 1)));
      setNavigationSerial((n) => n + 1);
    },
    [total],
  );
  const next = useCallback(() => goTo(stepIndex + 1), [goTo, stepIndex]);
  const stepOver = useCallback(() => {
    if (!trace) return;
    const depth = trace.steps[stepIndex]?.frames.length ?? 0;
    const from = trace.steps[stepIndex];
    // Past calls: stop at the next line of this function, or wherever it returns to.
    let i = stepIndex + 1;
    while (i < trace.steps.length - 1) {
      const s = trace.steps[i]!;
      if (s.frames.length < depth || (s.frames.length === depth && (s.frameId !== from?.frameId || s.span.startLine !== from?.span.startLine))) break;
      i++;
    }
    goTo(i);
  }, [goTo, stepIndex, trace]);
  const touches = useCallback((path: string) => trace?.steps.some((s) => s.span.path === path) ?? false, [trace]);
  const prev = useCallback(() => {
    setPlaying(false);
    goTo(stepIndex - 1);
  }, [goTo, stepIndex]);
  const restart = useCallback(() => {
    setPlaying(false);
    goTo(0);
  }, [goTo]);
  const togglePlay = useCallback(() => {
    setPlaying((p) => {
      if (!p && stepIndex >= total - 1) goTo(0);
      return !p;
    });
  }, [stepIndex, total, goTo]);

  const timer = useRef<number | null>(null);
  useEffect(() => {
    if (!playing) return;
    if (stepIndex >= total - 1) {
      setPlaying(false);
      return;
    }
    timer.current = window.setTimeout(() => goTo(stepIndex + 1), STEP_INTERVAL_MS / speed);
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, [playing, stepIndex, total, speed, goTo]);

  return {
    ready: sources !== null && (modules.size > 0 || sources.size === 0),
    sources,
    scenarios,
    scenario,
    selectScenario: setScenarioId,
    suggestedScenario,
    inputFields,
    setInputText,
    commitInput,
    params,
    setParamText,
    commitParam,
    setParamField,
    fillExample,
    choose,
    stepOver,
    touches,
    selectScenarioFor,
    selectScenarioAt,
    resetInputs,
    missingParams,
    missingData,
    setDataText,
    commitData,
    trace,
    step: trace?.steps[stepIndex] ?? null,
    stepIndex,
    goTo,
    next,
    prev,
    restart,
    playing,
    togglePlay,
    speed,
    setSpeed,
    callIndex,
    navigationSerial,
  };
}
