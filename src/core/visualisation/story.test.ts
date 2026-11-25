import { describe, expect, it } from 'vitest';
import { parsePythonModule } from '../parser/python/ast';
import { simulate } from '../simulation/interpreter';
import { parseLiteral } from '../simulation/literal';
import { findEditableInputs } from '../simulation/scenarios';
import { storyFor, type StoryTile } from './story';

const MAIN = 'from pricing import calculate_total\n\nprices = [12.0, 8.0, 5.0]\ndiscount = 0.10\n\nsubtotal = sum(prices)\n\ntotal = calculate_total(subtotal, discount)\n\nprint(total)\n';
const PRICING = 'def calculate_total(subtotal, discount):\n    discount_amount = subtotal * discount\n    final_amount = subtotal - discount_amount\n\n    return final_amount\n';
const USAGE = 'import pandas as pd\n\ndef usage_for_first_station(hours_usage, stationary):\n    result = float(\n        hours_usage.to_numpy(dtype=float)[stationary.iloc[0]]\n    )\n    return result\n\nif __name__ == "__main__":\n    hours_usage = pd.Series([10.5, 20.0, 30.5])\n    stationary = pd.Series([2, 0, 1])\n    print(usage_for_first_station(hours_usage, stationary))\n';

const shop = simulate({ sources: new Map([['main.py', MAIN], ['pricing.py', PRICING]]) }, { kind: 'script', path: 'main.py' });
const usage = simulate({ sources: new Map([['analysis/usage.py', USAGE]]) }, { kind: 'script', path: 'analysis/usage.py' });

const story = (trace: typeof shop, code: string) => {
  const step = trace.steps.find((s) => s.code.replace(/\s+/g, ' ').trim() === code)!;
  return storyFor(step, trace);
};
const tileText = (tiles: readonly StoryTile[]) =>
  tiles
    .map((t) => (t.kind === 'op' ? t.text : t.kind === 'box' || t.kind === 'helper' ? `[${t.name}]` : t.kind === 'list' ? `{${t.items.map((x, i) => (i === t.selected ? `*${x}*` : x)).join(' ')}}` : t.kind === 'place' ? `(${t.text})` : t.kind === 'table' ? `<table ${t.header.join(',')}>` : t.kind === 'object' ? `<${t.cls}>` : t.text))
    .join(' ');

describe('storyFor — plain-language steps', () => {
  it('turns sum(prices) into an addition with the real numbers and says where the answer goes', () => {
    const s = story(shop, 'sum(prices)');
    expect(s.headline).toBe('Add up all the numbers in “prices”.');
    expect(tileText(s.tiles)).toBe('12.0 + 8.0 + 5.0 = 25.0');
    expect(s.next).toBe('Next, 25.0 goes into the box called “subtotal”.');
  });

  it('shows multiplication as a picture-sum with box names as captions', () => {
    const s = story(shop, 'subtotal * discount');
    expect(s.headline).toBe('Multiply 25.0 by 0.1.');
    expect(s.tiles).toEqual([
      { kind: 'value', text: '25.0', caption: 'subtotal', source: 'subtotal' },
      { kind: 'op', text: '×' },
      { kind: 'value', text: '0.1', caption: 'discount', source: 'discount' },
      { kind: 'op', text: '=' },
      { kind: 'result', text: '2.5' },
    ]);
  });

  it('describes storing, calling a helper, returning and printing in simple words', () => {
    expect(story(shop, 'prices = [12.0, 8.0, 5.0]').headline).toBe('Put [12.0, 8.0, 5.0] into the box called “prices”.');
    expect(story(shop, 'calculate_total(subtotal, discount)').headline).toBe('Ask the helper “calculate_total” to do a job and hand it 25.0 and 0.1.');
    const ret = story(shop, 'return final_amount');
    expect(ret.headline).toBe('The helper “calculate_total” is finished! It sends back the answer 22.5.');
    expect(story(shop, 'print(total)').headline).toBe('Show 22.5 in the console.');
  });

  it('explains list spots with the chosen spot highlighted', () => {
    const iloc = story(usage, 'stationary.iloc[0]');
    expect(iloc.headline).toBe('Look in “stationary” at spot 0 (spots are counted 0, 1, 2…). It holds 2.');
    expect(tileText(iloc.tiles)).toBe('{*2* 0 1} [0] = 2');
    const pick = story(usage, 'hours_usage.to_numpy(dtype=float)[stationary.iloc[0]]');
    expect(tileText(pick.tiles)).toBe('{10.5 20.0 *30.5*} [2] = 30.5');
  });

  it('explains an out-of-range spot like a child would understand it', () => {
    const inputs = findEditableInputs('analysis/usage.py', parsePythonModule(USAGE));
    const bad = parseLiteral('[5, 0, 1]');
    if (!bad.ok) throw new Error(bad.error);
    const t = simulate({ sources: new Map([['analysis/usage.py', USAGE]]) }, { kind: 'script', path: 'analysis/usage.py' }, { overrides: new Map([[inputs[1]!.key, bad.value]]) });
    const s = storyFor(t.steps[t.steps.length - 1]!, t);
    expect(s.tone).toBe('error');
    expect(s.headline).toBe('Uh-oh! There is no spot 5. The list only has 3 spots (0 to 2).');
  });

  it('has a story for every step of both examples', () => {
    for (const trace of [shop, usage]) {
      for (const step of trace.steps) {
        const s = storyFor(step, trace);
        expect(s.headline.length, step.code).toBeGreaterThan(5);
        expect(s.headline, step.code).not.toMatch(/undefined|null|\[object/);
      }
    }
  });
});
