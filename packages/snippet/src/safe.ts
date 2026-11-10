/**
 * Fail-open guard. Nothing the snippet does may ever throw into the host page.
 * Errors are counted (and reported in the next batch) instead of propagated.
 */
let errorCount = 0;

export function safe<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R | undefined {
  return (...args: A) => {
    try {
      return fn(...args);
    } catch {
      errorCount++;
      return undefined;
    }
  };
}

export function run<R>(fn: () => R): R | undefined {
  try {
    return fn();
  } catch {
    errorCount++;
    return undefined;
  }
}

export function takeErrorCount(): number {
  const n = errorCount;
  errorCount = 0;
  return n;
}
