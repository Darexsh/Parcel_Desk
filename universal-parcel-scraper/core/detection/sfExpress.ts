/**
 * SF Express waybill check digit.
 *
 * What it is: the check on SF Express's 12-digit and `SF` + 13-digit waybills,
 * used by the `"sf-express"` detection rules.
 * What it is not: no carrier lookup and no provider I/O. The caller passes an
 * already-normalized number; anything else fails the shape test.
 */

/**
 * The first three digits are an area code outside the check. Read from the
 * right, the serial after them weighs 1, 3, 5, …; each product adds its tens
 * and its units, and the last digit tops the sum up to a multiple of ten. This
 * reproduces SF's published rule for numbering consecutive waybills.
 */
export function isValidSfExpressWaybill(value: string): boolean {
  const digits = /^(?:\d{12}|SF\d{13})$/.test(value) ? value.replace(/^SF/, '') : null;
  if (!digits) return false;
  const sum = [...digits.slice(3, -1)].reverse().reduce((total, digit, index) => {
    const product = Number(digit) * (2 * index + 1);
    return total + Math.floor(product / 10) + product % 10;
  }, 0);
  return (10 - sum % 10) % 10 === Number(digits.at(-1));
}
