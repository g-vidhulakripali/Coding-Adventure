import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { buildCallIndex, type CallIndex } from '../../core/analysis/python/callIndex';
import { parsePythonModule, type Module } from '../../core/parser/python/ast';
import { simulate, type SimulationEntry } from '../../core/simulation/interpreter';
import { parseLiteral } from '../../core/simulation/literal';
import { findEditableInputs, findScenarios, type EditableInput, type ScenarioOption } from '../../core/simulation/scenarios';
import type { Step, Trace } from '../../core/simulation/trace';
import { pyRepr, type PyValue } from '../../core/simulation/values';

export type PlaybackSpeed = 0.5 | 1 | 2;

export interface ParamInput {
  /** Unique key: `init:<name>` (values to make the object) or `call:<name>` (the function/method's own). */
  readonly key: string;
  readonly group: 'init' | 'call';
  readonly name: string;
  readonly text: string;
  readonly value: PyValue | null;
  readonly error: string | null;
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
  const modules = useMemo(() => {
    const map = new Map<string, Module>();
    if (sources) for (const [path, text] of sources) map.set(path, parsePythonModule(text));
    return map;
  }, [sources]);

  const callIndex = useMemo(() => (sources ? buildCallIndex(sources) : null), [sources]);

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
    if (scenarioId || allScenarios.length === 0) return;
    const scripts = allScenarios.filter((s) => s.kind === 'script');
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
      [...scripts].sort((a, b) => entryRank(a.path) - entryRank(b.path))[0] ??
      allScenarios.find((s) => s.path === currentFile) ??
      null;
    if (pick) setScenarioId(pick.id);
  }, [allScenarios, currentFile, scenarioId, callIndex]);

  const suggestedScenario = useMemo(() => {
    if (!currentFile || scenario?.path === currentFile) return null;
    return allScenarios.find((s) => s.path === currentFile && s.kind === 'script') ?? allScenarios.find((s) => s.path === currentFile) ?? null;
  }, [allScenarios, currentFile, scenario]);

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

  // Reset per scenario.
  useEffect(() => {
    setTexts({});
    setOverrides(new Map());
    setErrors({});
    setParamTexts({});
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
  const params: ParamInput[] = specs.map((p) => ({
    key: p.key,
    group: p.group,
    name: p.name,
    text: paramTexts[p.key] ?? (paramValues.get(p.key) ? pyRepr(paramValues.get(p.key)!) : ''),
    value: paramValues.get(p.key) ?? null,
    error: errors[`param:${p.key}`] ?? null,
  }));
  const setParamText = useCallback((key: string, text: string) => setParamTexts((t) => ({ ...t, [key]: text })), []);
  const commitParam = useCallback(
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
    setParamValues(defaultsFor(scenario));
  }, [scenario]);

  const missingParams = specs.filter((p) => !paramValues.has(p.key)).map((p) => p.name);

  const pick = (group: 'init' | 'call') =>
    new Map(specs.filter((p) => p.group === group && paramValues.has(p.key)).map((p) => [p.name, paramValues.get(p.key)!] as const));

  // ---- Trace -------------------------------------------------------------------
  const trace = useMemo(() => {
    if (!sources || !scenario) return null;
    let entry: SimulationEntry;
    if (paramSpecs(scenario).some((p) => !paramValues.has(p.key))) return null;
    if (scenario.kind === 'script') entry = { kind: 'script', path: scenario.path };
    else if (scenario.kind === 'method') {
      entry = { kind: 'method', path: scenario.path, className: scenario.className, method: scenario.method, initArgs: pick('init'), args: pick('call') };
    } else entry = { kind: 'function', path: scenario.path, name: scenario.name, args: pick('call') };
    return simulate({ sources, dataFiles: allDataFiles }, entry, { overrides });
  }, [sources, allDataFiles, scenario, overrides, paramValues]); // pick/specs derive from scenario + paramValues

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
    ready: sources !== null,
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
