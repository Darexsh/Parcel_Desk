/** Ozon's complete posting, with the separators required by its guest tracker. */
export function ozonPosting(raw: string): string | null {
  const number = raw.replace(/[\s-]/g, '');
  return /^(?:\d{13}|\d{15})$/.test(number)
    ? `${number.slice(0, -5)}-${number.slice(-5, -1)}-${number.slice(-1)}` : null;
}
