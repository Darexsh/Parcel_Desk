/** An ACS Courier voucher number: ten digits, as on every label and sample seen. */
export function isAcsVoucherNumber(number: string): boolean {
  return /^\d{10}$/.test(number);
}
