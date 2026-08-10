/**
 * Format USD for utterance cost UI.
 *
 * Always decimal (no toExponential / scientific / hex). Small nonzero values
 * keep enough fraction digits so they do not collapse to `$0`.
 */

const MAX_FRACTION_DIGITS = 16;

const stripTrailingZeros = (body: string): string =>
  body.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");

/** Visible decimal USD string including the `$` prefix. */
export const formatDecimalUsd = (usd: number): string => {
  if (!Number.isFinite(usd) || usd <= 0) {
    return "$0";
  }
  const fractionDigits = usd >= 1 ? 2 : MAX_FRACTION_DIGITS;
  const body = stripTrailingZeros(usd.toFixed(fractionDigits));
  if (!body || body === "0") {
    return "$0";
  }
  return `$${body}`;
};
