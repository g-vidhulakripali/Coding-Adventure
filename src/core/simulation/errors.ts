import type { Span } from '../parser/python/ast';

/** A modelled Python exception (e.g. IndexError). Shown as an error step; the simulation stops. */
export class PyError extends Error {
  /** Innermost expression where the error arose; attached while unwinding. */
  span?: Span;
  /** Set once the failure step has been recorded (while the call stack was still intact). */
  recorded = false;
  constructor(
    readonly pyType: string,
    message: string,
  ) {
    super(message);
  }
}

/** Something outside the simulation model. Shown as an unsupported step; the simulation stops. */
export class UnsupportedError extends Error {
  recorded = false;
  constructor(
    message: string,
    public span?: Span,
  ) {
    super(message);
  }
}

/** A data file the code reads (e.g. with pd.read_csv) is not in the project. The user can supply sample rows. */
export class MissingDataError extends UnsupportedError {
  constructor(
    readonly missingPath: string,
    span?: Span,
  ) {
    super(`The file “${missingPath}” is not in this project, so there is no data to read. Paste a few sample rows in the inputs tab to try it.`, span);
  }
}
