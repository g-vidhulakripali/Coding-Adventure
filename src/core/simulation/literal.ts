import type { PyValue } from './values';

/**
 * Parses a Python literal typed by the user into an input value.
 *
 * Accepts numbers, strings, True/False/None and (nested) lists/tuples of those
 * — the same shapes `ast.literal_eval` accepts for these types. Nothing is
 * evaluated: this is a small recursive-descent parser.
 */
export function parseLiteral(input: string): { ok: true; value: PyValue } | { ok: false; error: string } {
  const parser = new LiteralParser(input);
  try {
    const value = parser.value();
    parser.skipSpace();
    if (!parser.done()) return { ok: false, error: `Unexpected text at position ${parser.pos + 1}` };
    return { ok: true, value };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

class LiteralParser {
  pos = 0;
  constructor(private readonly s: string) {}

  done() {
    return this.pos >= this.s.length;
  }

  skipSpace() {
    while (!this.done() && /\s/.test(this.s[this.pos]!)) this.pos++;
  }

  value(): PyValue {
    this.skipSpace();
    const ch = this.s[this.pos];
    if (ch === undefined) throw new Error('Expected a value');
    if (ch === '[') return { t: 'list', items: this.sequence(']') };
    if (ch === '(') {
      const items = this.sequence(')');
      return { t: 'tuple', items };
    }
    if (ch === '"' || ch === "'") return { t: 'str', v: this.string(ch) };
    for (const [word, value] of [
      ['True', { t: 'bool', v: true }],
      ['False', { t: 'bool', v: false }],
      ['None', { t: 'none' }],
    ] as const) {
      if (this.s.startsWith(word, this.pos) && !/[\w]/.test(this.s[this.pos + word.length] ?? '')) {
        this.pos += word.length;
        return value;
      }
    }
    return this.number();
  }

  private sequence(close: string): PyValue[] {
    this.pos++; // opening bracket
    const items: PyValue[] = [];
    this.skipSpace();
    if (this.s[this.pos] === close) {
      this.pos++;
      return items;
    }
    for (;;) {
      items.push(this.value());
      this.skipSpace();
      const ch = this.s[this.pos];
      if (ch === ',') {
        this.pos++;
        this.skipSpace();
        if (this.s[this.pos] === close) {
          this.pos++;
          return items;
        }
        continue;
      }
      if (ch === close) {
        this.pos++;
        return items;
      }
      throw new Error(`Expected "," or "${close}"`);
    }
  }

  private string(quote: string): string {
    this.pos++;
    let out = '';
    while (!this.done()) {
      const ch = this.s[this.pos]!;
      if (ch === quote) {
        this.pos++;
        return out;
      }
      if (ch === '\\') {
        const next = this.s[this.pos + 1];
        out += next === 'n' ? '\n' : next === 't' ? '\t' : (next ?? '');
        this.pos += 2;
        continue;
      }
      out += ch;
      this.pos++;
    }
    throw new Error('Unterminated string');
  }

  private number(): PyValue {
    const match = /^[-+]?(\d[\d_]*)?(\.\d*)?([eE][-+]?\d+)?/.exec(this.s.slice(this.pos));
    const text = match?.[0] ?? '';
    if (!text || !/\d/.test(text)) throw new Error(`Not a valid literal near "${this.s.slice(this.pos, this.pos + 12)}"`);
    this.pos += text.length;
    const clean = text.replace(/_/g, '');
    if (/^[-+]?\d+$/.test(clean)) {
      const v = Number(clean);
      if (!Number.isSafeInteger(v)) throw new Error('Integer too large for exact simulation');
      return { t: 'int', v };
    }
    return { t: 'float', v: Number(clean) };
  }
}
