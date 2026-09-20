/**
 * Tiny schema objects for the `ask` session-projection unit.
 *
 * Why not `zod`: the projection registry only ever calls `parse` (and any
 * caller may use `safeParse`) on `stateSchema`/`viewSchema`
 * (`@deepseek-ai/dsh-session-projection` 0.1.5-rc.2). Importing `zod` would
 * add a bare-specifier dependency that resolves for a pnpm-installed plugin but
 * NOT for a `link:`-installed one — Node resolves a linked package's imports
 * from its real path, outside the profile's `node_modules`. Keeping the plugin
 * import-free is what makes `dsh plugin --profile web add link:<dir>` and
 * `... add github:<owner>/<repo>` behave identically, so the two schema objects
 * below implement the same `parse` contract with no dependency at all.
 *
 * The API shape deliberately mirrors zod's: `parse` throws on a violation and
 * returns the validated value; `safeParse` returns `{ success, data | error }`.
 * Objects are strict — an unknown key is a violation — so a persisted
 * checkpoint written by a future state shape is rejected instead of being
 * silently narrowed (which is what `stateVersion` is for).
 *
 * @module dsh-helper-plugin-command-ask/lib/schema
 */

/** Render a value for a violation message without throwing on weird input. */
function describe(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (value === undefined) return 'undefined';
  if (typeof value === 'function') return 'a function';
  if (value !== null && typeof value === 'object') {
    try {
      return JSON.stringify(value) ?? String(value);
    } catch {
      return Object.prototype.toString.call(value);
    }
  }
  return String(value);
}

/** One validation rule: `check` returns an expectation string when violated. */
class Rule {
  /**
   * @param {(value: unknown) => string | undefined} check - violation test.
   * @param {string} expectation - human description used in the thrown error.
   * @param {(value: unknown) => unknown} [normalize] - optional validated value.
   */
  constructor(check, expectation, normalize) {
    this.check = check;
    this.expectation = expectation;
    this.normalize = normalize ?? ((value) => value);
  }

  /** Validate or throw. */
  parse(value) {
    const violation = this.check(value);
    if (violation !== undefined) {
      throw new Error(`ask-mode projection schema: expected ${violation}, got ${describe(value)}`);
    }
    return this.normalize(value);
  }

  /** Validate without throwing. */
  safeParse(value) {
    try {
      return { success: true, data: this.parse(value) };
    } catch (error) {
      return { success: false, error };
    }
  }
}

/** A boolean. */
export const boolean = new Rule(
  (value) => (typeof value === 'boolean' ? undefined : 'a boolean'),
  'a boolean',
);

/** A non-empty string. */
export const nonEmptyString = new Rule(
  (value) => (typeof value === 'string' && value !== '' ? undefined : 'a non-empty string'),
  'a non-empty string',
);

/** `inner` or `null`. */
export function nullable(inner) {
  return new Rule(
    (value) => (value === null ? undefined : inner.check(value)),
    `null or ${inner.expectation}`,
  );
}

/**
 * Build a strict object rule: every key in `shape` must validate, and no other
 * key may be present.
 *
 * @param {Record<string, Rule>} shape - the exact accepted keys.
 * @returns {Rule} the object rule.
 */
export function object(shape) {
  const keys = Object.keys(shape);
  return new Rule(
    (value) => {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return 'a plain object';
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(shape, key)) return `no key other than ${keys.map((name) => JSON.stringify(name)).join(', ')} (found ${JSON.stringify(key)})`;
      }
      for (const key of keys) {
        const violation = shape[key].check(value[key]);
        if (violation !== undefined) return `${JSON.stringify(key)} to be ${violation}`;
      }
      return undefined;
    },
    'a plain object with exactly the declared keys',
  );
}

/** Projection state written by `ask/mode` and the folded `/ask` command records. */
export const askStateSchema = object({
  /** Whether ask mode is the logged, durable state for the session. */
  active: boolean,
  /** A settled `/ask` selection whose boundary append has not happened yet. */
  wanted: nullable(boolean),
  /** The `/ask` invocation currently running, if any. */
  running: nullable(object({
    commandId: nonEmptyString,
    wanted: boolean,
  })),
  /** `active` as of the last `request/header`; `null` until a request was made. */
  activeAtLastHeader: nullable(boolean),
});

/** The client-visible `ask` projection value. */
export const askViewSchema = object({
  active: boolean,
  pending: boolean,
});
