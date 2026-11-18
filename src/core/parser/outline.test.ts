import { describe, expect, it } from 'vitest';
import { extractPythonOutline, flattenOutline } from './outline';

describe('extractPythonOutline', () => {
  it('finds a top-level function with its exact line range', () => {
    const source = ['def calculate_total(subtotal, discount):', '    discount_amount = subtotal * discount', '    final_amount = subtotal - discount_amount', '', '    return final_amount', ''].join('\n');
    const { symbols, syntaxErrorCount } = extractPythonOutline(source);
    expect(syntaxErrorCount).toBe(0);
    expect(symbols).toHaveLength(1);
    expect(symbols[0]).toMatchObject({
      kind: 'function',
      name: 'calculate_total',
      isAsync: false,
      decorated: false,
      line: 1,
      range: { startLine: 1, endLine: 5 },
    });
  });

  it('distinguishes classes, methods, async, decorators and nested functions', () => {
    const source = `import x

@dataclass
class Report(Base):
    def __init__(self):
        self.a = 1

    @property
    def total(self):
        return 1

    async def refresh(self):
        def helper():
            pass
        return helper

def outer():
    pass
`;
    const { symbols } = extractPythonOutline(source);
    expect(symbols.map((s) => `${s.kind}:${s.name}`)).toEqual(['class:Report', 'function:outer']);

    const report = symbols[0]!;
    expect(report.decorated).toBe(true);
    expect(report.range.startLine).toBe(3); // decorator line
    expect(report.line).toBe(4); // `class` keyword line
    expect(report.range.endLine).toBe(15);
    expect(report.children.map((c) => `${c.kind}:${c.name}`)).toEqual(['method:__init__', 'method:total', 'method:refresh']);

    const total = report.children[1]!;
    expect(total.decorated).toBe(true);
    expect(total.range).toEqual({ startLine: 8, endLine: 10 });

    const refresh = report.children[2]!;
    expect(refresh.isAsync).toBe(true);
    expect(refresh.children.map((c) => `${c.kind}:${c.name}`)).toEqual(['function:helper']);

    // Report, __init__, total, refresh, helper, outer
    expect(flattenOutline(symbols).map((s) => s.name)).toEqual(['Report', '__init__', 'total', 'refresh', 'helper', 'outer']);
  });

  it('finds definitions inside module-level blocks', () => {
    const source = `try:
    def fast():
        pass
except ImportError:
    def fast():
        pass

if __name__ == "__main__":
    def main():
        pass
`;
    const names = extractPythonOutline(source).symbols.map((s) => `${s.name}@${s.line}`);
    expect(names).toEqual(['fast@2', 'fast@5', 'main@9']);
  });

  it('reports syntax-error recovery instead of failing', () => {
    const result = extractPythonOutline('def ok():\n    return 1\n\ndef broken(:\n    pass\n');
    expect(result.syntaxErrorCount).toBeGreaterThan(0);
    expect(result.symbols.some((s) => s.name === 'ok')).toBe(true);
  });

  it('handles empty files', () => {
    expect(extractPythonOutline('')).toEqual({ symbols: [], syntaxErrorCount: 0 });
  });
});
