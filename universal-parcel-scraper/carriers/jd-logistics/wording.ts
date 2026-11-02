/**
 * JD's out-for-delivery wording names the courier and gives their phone in
 * brackets: "the courier is 【name，phone】,". The clause is dropped and the
 * rest of the sentence kept.
 */
const COURIER_CONTACT = /\s*the courier is\s*【[^】]*】\s*,?/i;

export function withoutCourierContact(text: string): string {
  return text.replace(COURIER_CONTACT, '').replace(/\s+/g, ' ').trim();
}

/**
 * JD's departure from its warehouse ends with the last-mile partner's number:
 * "Departed from Warehouse.Tracking no GFUS…". The number belongs to the
 * hand-off, not the wording.
 */
const PARTNER_NUMBER = /\s*Tracking\s+no\b\.?\s*[:：]?\s*([A-Za-z0-9]{6,40})\s*\.?\s*$/i;

/** The partner's number a scan's wording ends with, or undefined. */
export function partnerNumber(text: string): string | undefined {
  const number = PARTNER_NUMBER.exec(text)?.[1]?.toUpperCase();
  return number && /\d/.test(number) ? number : undefined;
}

/** The scan's wording without the partner's number it ends with. */
export function withoutPartnerNumber(text: string): string {
  return partnerNumber(text) ? text.replace(PARTNER_NUMBER, '').trim() : text;
}

/** A scan's wording as JD's history keeps it: no courier's contact, no partner's number. */
export function scanWording(text: string): string {
  return withoutPartnerNumber(withoutCourierContact(text));
}
