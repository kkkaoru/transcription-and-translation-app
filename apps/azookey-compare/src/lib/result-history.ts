// This file runs with bun.

const MAX_RESULT_HISTORY: number = 100;

export const prependResultHistory = <Result>(current: Result[], result: Result): Result[] =>
  [result, ...current].slice(0, MAX_RESULT_HISTORY);
