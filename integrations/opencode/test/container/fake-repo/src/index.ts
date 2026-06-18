/**
 * A collection of utility functions with some intentional bugs and TODOs.
 * Used as the working directory for e2e agent tests.
 */

/**
 * Clamps a number between min and max (inclusive).
 * BUG: returns min when value === max (off-by-one)
 */
export function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value < max) return max; // BUG: should be value > max
  return value;
}

/**
 * Returns the sum of all numbers in an array.
 * BUG: initial accumulator is wrong for empty arrays
 */
export function sum(nums: number[]): number {
  return nums.reduce((acc, n) => acc + n); // BUG: missing initial value 0
}

/**
 * Truncates a string to maxLength characters, appending "..." if truncated.
 */
export function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength) + "...";
}

/**
 * Groups an array of objects by a key.
 * TODO: handle the case where the key value is undefined
 */
export function groupBy<T>(items: T[], key: keyof T): Record<string, T[]> {
  const result: Record<string, T[]> = {};
  for (const item of items) {
    const k = String(item[key]);
    if (!result[k]) result[k] = [];
    result[k].push(item);
  }
  return result;
}

/**
 * Formats a duration in milliseconds as a human-readable string.
 * e.g. 90000 -> "1m 30s", 3661000 -> "1h 1m 1s"
 * TODO: implement this function
 */
export function formatDuration(ms: number): string {
  // TODO: implement
  return `${ms}ms`;
}

/**
 * Deep-merges two objects. Later keys win.
 * BUG: arrays are merged incorrectly (treated as objects)
 */
export function deepMerge<T extends Record<string, unknown>>(base: T, override: Partial<T>): T {
  const result = { ...base };
  for (const key of Object.keys(override) as (keyof T)[]) {
    const bv = base[key];
    const ov = override[key];
    if (
      ov !== null &&
      typeof ov === "object" &&
      !Array.isArray(ov) &&
      typeof bv === "object" &&
      bv !== null &&
      !Array.isArray(bv)
    ) {
      result[key] = deepMerge(bv as Record<string, unknown>, ov as Record<string, unknown>) as T[keyof T];
    } else {
      result[key] = ov as T[keyof T];
    }
  }
  return result;
}
