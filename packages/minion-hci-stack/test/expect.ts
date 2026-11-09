import assert from "node:assert/strict";

/**
 * A tiny Bun/Jest-style `expect` over `node:assert/strict`, so the test bodies
 * stay unchanged after moving from `bun:test` to `node:test`. It implements only
 * the matchers this suite uses, plus `.not`.
 */
type Matchers = {
  toBe(expected: unknown): void;
  toEqual(expected: unknown): void;
  toBeNull(): void;
  toBeUndefined(): void;
  toBeCloseTo(expected: number, digits?: number): void;
  toThrow(): void;
  toBeLessThan(expected: number): void;
  toBeGreaterThan(expected: number): void;
  toContain(expected: unknown): void;
};

function matchers(actual: unknown, negated: boolean): Matchers {
  const check = (pass: boolean, message: string): void => assert.ok(negated ? !pass : pass, message);
  return {
    toBe(expected) {
      if (negated) assert.notStrictEqual(actual, expected);
      else assert.strictEqual(actual, expected);
    },
    toEqual(expected) {
      if (negated) assert.notDeepStrictEqual(actual, expected);
      else assert.deepStrictEqual(actual, expected);
    },
    toBeNull() {
      if (negated) assert.notStrictEqual(actual, null);
      else assert.strictEqual(actual, null);
    },
    toBeUndefined() {
      if (negated) assert.notStrictEqual(actual, undefined);
      else assert.strictEqual(actual, undefined);
    },
    toBeCloseTo(expected, digits = 2) {
      const near = Math.abs((actual as number) - expected) < 10 ** -digits / 2;
      check(near, `expected ${String(actual)} ${negated ? "not " : ""}to be close to ${expected} (precision ${digits})`);
    },
    toThrow() {
      if (negated) assert.doesNotThrow(actual as () => unknown);
      else assert.throws(actual as () => unknown);
    },
    toBeLessThan(expected) {
      check((actual as number) < expected, `expected ${String(actual)} ${negated ? "not " : ""}to be less than ${expected}`);
    },
    toBeGreaterThan(expected) {
      check((actual as number) > expected, `expected ${String(actual)} ${negated ? "not " : ""}to be greater than ${expected}`);
    },
    toContain(expected) {
      check((actual as { includes(value: unknown): boolean }).includes(expected), `expected ${String(actual)} ${negated ? "not " : ""}to contain ${String(expected)}`);
    },
  };
}

/** Bun-style `expect` for the subset of matchers the suite uses. */
export function expect(actual: unknown): Matchers & { not: Matchers } {
  return { ...matchers(actual, false), not: matchers(actual, true) };
}
