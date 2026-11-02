/**
 * NO LIMIT's shipment numbers: P and a serial, L and the three letters of the
 * branch that took the order, and the year, printed with slashes between them
 * (P/1234/LABC/2026). Letters and digits alternate, so the number reads the
 * same without its slashes, which normalization drops. NO LIMIT's form finds
 * a shipment only with them.
 */
const SHIPMENT = /^P\/?(\d{1,6})\/?L([A-Z]{3})\/?(20\d{2})$/;

/** The number without its slashes when it is a NO LIMIT shipment number, typed with or without them. */
export function noLimitShipmentNumber(value: string): string | undefined {
  const parts = SHIPMENT.exec(value);
  return parts ? `P${parts[1]}L${parts[2]}${parts[3]}` : undefined;
}

/** The number as NO LIMIT prints it and its form finds it, with its slashes. */
export function noLimitPrintedNumber(value: string): string | undefined {
  const parts = SHIPMENT.exec(value);
  return parts ? `P/${parts[1]}/L${parts[2]}/${parts[3]}` : undefined;
}
