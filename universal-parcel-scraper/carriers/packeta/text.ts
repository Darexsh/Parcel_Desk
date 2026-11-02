/** Packeta's event sentences, which link a delivery partner's number to that partner's tracker. */

// Bounded so a malformed reply cannot make the scan slow.
const MAX_TEXT_LENGTH = 4_000;
const LINK = /<a\s[^>]*?href="([^"<>]{1,1000})"[^>]*>([^<]{0,200})<\/a>/gi;

export interface PacketaEventLink {
  url: string;
  /** The text the sentence shows for the link: the partner's number. */
  text: string;
}

/** The sentence as Packeta's page shows it: each link keeps its text, and no markup is left. */
export function packetaEventText(raw: string): string {
  return raw.slice(0, MAX_TEXT_LENGTH).replace(LINK, '$2').replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, 500);
}

// Three sentences name a depot or point: the reception and the notice of a
// parcel ready for pickup after their sentence ("… for transport. DEPO
// Example"), and the depot arrival within it.
const PLACED = [
  /^(We have successfully received the parcel for transport\.) (\S.*)$/,
  /^(The parcel is ready for pickup\.) (\S.*)$/,
  /^(Your parcel has arrived at the depot) (\S.*)(\. We[’']re now preparing it for delivery\.)$/,
];

/** A sentence's wording and the depot or point it names, which is the scan's place. */
export function packetaPlacedText(sentence: string): { description: string; location: string } {
  for (const pattern of PLACED) {
    const match = pattern.exec(sentence);
    if (match) return { description: match[1]! + (match[3] ?? ''), location: match[2]! };
  }
  return { description: sentence, location: '' };
}

/** The links a sentence holds, in order. */
export function packetaEventLinks(raw: string): PacketaEventLink[] {
  return [...raw.slice(0, MAX_TEXT_LENGTH).matchAll(LINK)].map(([, url, text]) => ({
    url: url!.replace(/&amp;/g, '&'),
    text: text!.replace(/\s+/g, ' ').trim(),
  }));
}
