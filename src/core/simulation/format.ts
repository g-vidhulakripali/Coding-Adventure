import { PyError, UnsupportedError } from './errors';
import { floatRepr, numericOf, pyRepr, pyStrOf, typeName, type PyValue } from './values';

/** Python's `format(value, spec)` for numbers and text (the mini-language used in f-strings). */
const SPEC = /^(?:(.)?([<>=^]))?([-+ ])?(#)?(0)?(\d+)?([,_])?(?:\.(\d+))?([a-zA-Z%])?$/s;

export function formatValue(value: PyValue, spec: string): string {
  if (spec === '') return pyStrOf(value);
  const m = SPEC.exec(spec);
  if (!m) throw new UnsupportedError(`The format \`${spec}\` is not modelled.`);
  const [, fillRaw, alignRaw, sign, , zero, widthRaw, group, precRaw, type] = m;
  const width = widthRaw ? Number(widthRaw) : 0;
  const n = numericOf(value);
  const isNumber = n !== null && value.t !== 'bool';
  if (n === null || (!isNumber && !type)) {
    if (spec && value.t !== 'str' && value.t !== 'bool') throw new PyError('TypeError', `unsupported format string passed to ${typeName(value)}.__format__`);
    if (type && type !== 's') throw new PyError('ValueError', `Unknown format code '${type}' for object of type '${typeName(value)}'`);
    let text = pyStrOf(value);
    if (precRaw !== undefined) text = text.slice(0, Number(precRaw));
    return pad(text, width, alignRaw ?? '<', fillRaw ?? ' ', '');
  }
  const isInt = value.t === 'int' || value.t === 'bool' || (value.t === 'np-scalar' && value.dtype !== 'float64');
  const abs = Math.abs(n);
  const negative = n < 0 || Object.is(n, -0);
  let body: string;
  const prec = precRaw === undefined ? undefined : Number(precRaw);
  if (!Number.isFinite(n)) body = Number.isNaN(n) ? 'nan' : 'inf';
  else
    switch (type) {
      case undefined:
        body = isInt ? String(abs) : prec === undefined ? floatRepr(abs) : general(abs, prec, true);
        break;
      case 'd':
      case 'n':
        if (!isInt) throw new PyError('ValueError', `Unknown format code 'd' for object of type '${typeName(value)}'`);
        body = String(abs);
        break;
      case 'f':
      case 'F':
        body = fixed(abs, prec ?? 6);
        break;
      case '%':
        body = `${fixed(abs * 100, prec ?? 6)}%`;
        break;
      case 'e':
      case 'E':
        body = expo(abs, prec ?? 6);
        break;
      case 'g':
      case 'G':
        body = general(abs, prec ?? 6, false);
        break;
      case 'x':
        body = abs.toString(16);
        break;
      case 'b':
        body = abs.toString(2);
        break;
      case 'o':
        body = abs.toString(8);
        break;
      default:
        throw new UnsupportedError(`The format code \`${type}\` is not modelled.`);
    }
  if (type === 'E' || type === 'G') body = body.toUpperCase();
  if (group && Number.isFinite(n)) {
    const [, int = '', rest = ''] = /^(\d+)(.*)$/.exec(body) ?? [];
    body = int.replace(/\B(?=(\d{3})+(?!\d))/g, group) + rest;
  }
  const prefix = negative ? '-' : sign === '+' ? '+' : sign === ' ' ? ' ' : '';
  if (zero && !alignRaw) return pad(body, width, '=', '0', prefix);
  return pad(body, width, alignRaw ?? '>', fillRaw ?? ' ', prefix);
}

function pad(body: string, width: number, align: string, fill: string, prefix: string): string {
  const missing = Math.max(0, width - body.length - prefix.length);
  switch (align) {
    case '<':
      return prefix + body + fill.repeat(missing);
    case '^':
      return fill.repeat(Math.floor(missing / 2)) + prefix + body + fill.repeat(Math.ceil(missing / 2));
    case '=':
      return prefix + fill.repeat(missing) + body;
    default:
      return fill.repeat(missing) + prefix + body;
  }
}

/** Fixed decimals with Python's round-half-even for exact ties. */
export function fixed(x: number, digits: number): string {
  if (x >= 1e21 || digits > 100) throw new UnsupportedError('This number is too large to format exactly.');
  const scale = 10 ** digits;
  const scaled = x * scale;
  const floor = Math.floor(scaled);
  if (scaled - floor === 0.5 && scaled / scale === x && digits <= 15 && (floor + 0.5) / scale === x && isExactTie(x, digits)) {
    return ((floor % 2 === 0 ? floor : floor + 1) / scale).toFixed(digits);
  }
  return x.toFixed(digits);
}

/** Whether x has an exact binary tie at `digits` decimals (so half-even applies). */
function isExactTie(x: number, digits: number): boolean {
  const text = x.toFixed(Math.min(100, digits + 30));
  return /^50*$/.test(text.slice(text.indexOf('.') + 1 + digits));
}

function expo(x: number, digits: number): string {
  const [mant, exp] = x.toExponential(Math.min(100, digits)).split('e') as [string, string];
  const e = Number(exp);
  return `${mant}e${e < 0 ? '-' : '+'}${String(Math.abs(e)).padStart(2, '0')}`;
}

function general(x: number, precision: number, keepPoint: boolean): string {
  const p = Math.max(1, precision);
  if (x === 0) return keepPoint ? '0.0' : '0';
  const exp = Number(x.toExponential(p - 1).split('e')[1]);
  if (exp < -4 || exp >= p) return expo(x, p - 1).replace(/\.?0+e/, 'e');
  const text = x.toFixed(Math.max(0, p - 1 - exp));
  const trimmed = text.includes('.') ? text.replace(/\.?0+$/, '') : text;
  return keepPoint && !trimmed.includes('.') ? `${trimmed}.0` : trimmed;
}

export function convert(value: PyValue, conversion: string | null): PyValue {
  if (conversion === 'r' || conversion === 'a') return { t: 'str', v: pyRepr(value) };
  if (conversion === 's') return { t: 'str', v: pyStrOf(value) };
  return value;
}
