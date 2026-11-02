/** J&T Cargo Indonesia masters and pieces confirmed by its own tracking feed. */
export const JNT_CARGO_MASTER_PATTERN = '^20\\d{10}$';
export const JNT_CARGO_PIECE_PATTERN = '^20\\d{13}$';
const MASTER = new RegExp(JNT_CARGO_MASTER_PATTERN);
const PIECE = new RegExp(JNT_CARGO_PIECE_PATTERN);

/** Shape eligibility only; neither a master nor a piece is confirmed offline. */
export function isJntCargoTrackingNumber(number: string): boolean {
  return MASTER.test(number) || PIECE.test(number);
}
