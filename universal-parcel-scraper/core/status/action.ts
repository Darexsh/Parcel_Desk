/**
 * The customs wordings in which a carrier asks the recipient to act before the
 * parcel can move on: give their tax number, pay the import duties or taxes,
 * or send documents.
 *
 * What it is: a short list of whole wordings, each one a carrier's own, read
 * into `recipient_action` by `normalizeCarrierResult`. What it is not: a
 * keyword search. A wording that only mentions customs, a payment or a
 * document says nothing about who must act, so it sets nothing.
 */

/**
 * What a carrier asks the recipient to do: `tax_id` give their tax number, such as Brazil's
 * CPF or CNPJ, `duties` pay the import duties or taxes, `documents` send customs documents.
 */
export type RecipientAction = 'tax_id' | 'duties' | 'documents';

export const RECIPIENT_ACTIONS: readonly RecipientAction[] = ['tax_id', 'duties', 'documents'];

/** Each wording lowercased, without accents and final full stop. */
const WORDINGS: readonly (readonly [RegExp, RecipientAction])[] = [
  // Correios, and its English as ParcelsApp and 17TRACK relay it.
  [/^necessidade de informar (?:o )?cpf\/cnpj do destinatario$/, 'tax_id'],
  [/^need to inform (?:the )?recipient'?s cpf\/cnpj$/, 'tax_id'],
  // UPS 7F and OQ, as relayed.
  [/^duties or taxes are due on this package$/, 'duties'],
  [/^your package is being held until duties and taxes are paid(?:\. awaiting customer action)?$/, 'duties'],
  // Omniva's payment requests for a customs declaration.
  [/^a notification of additional payment for customs declaration has been sent$/, 'duties'],
  [/^reminder of additional payment for a customs declaration$/, 'duties'],
  [/^shipment customs payment req reminder$/, 'duties'],
  // SMSA Express, Saudi Post and BUFFALO.
  [/^shipment on hold at customs - waiting to complete payment to customs$/, 'duties'],
  [/^waiting for customs payment$/, 'duties'],
  [/^customs vat and duty can be paid now, please pay in time$/, 'duties'],
  // Saudi Post and SMSA Express.
  [/^waiting for shipment documents from the customer$/, 'documents'],
  [/^delivery on hold - waiting customs info\/invoice completion$/, 'documents'],
];

export function isRecipientAction(value: unknown): value is RecipientAction {
  return typeof value === 'string' && (RECIPIENT_ACTIONS as readonly string[]).includes(value);
}

/** What a scan's wording asks the recipient to do, or undefined when it asks nothing explicitly. */
export function recipientAction(text: string | null | undefined): RecipientAction | undefined {
  if (!text) return undefined;
  const value = text.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('en-US')
    .replace(/[’‘`]/g, "'").replace(/\s+/g, ' ').trim().replace(/[.!]+$/, '');
  return WORDINGS.find(([wording]) => wording.test(value))?.[1];
}
