import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { recipientAction } from './action.js';

const CARRIERS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../carriers');

describe('recipient actions', () => {
  it('reads the customs wordings that ask the recipient to act, in any case, accents and final stop', () => {
    expect(recipientAction('Necessidade de informar CPF/CNPJ do destinatário')).toBe('tax_id');
    expect(recipientAction('NECESSIDADE DE INFORMAR CPF/CNPJ DO DESTINATARIO.')).toBe('tax_id');
    expect(recipientAction('Need to inform recipient’s CPF/CNPJ')).toBe('tax_id');
    expect(recipientAction('Duties or taxes are due on this package.')).toBe('duties');
    expect(recipientAction('Your package is being held until duties and taxes are paid. Awaiting customer action.')).toBe('duties');
    expect(recipientAction('Waiting for customs payment')).toBe('duties');
    expect(recipientAction('Waiting for shipment documents from the customer')).toBe('documents');
  });

  it('reads nothing into a wording that does not say the recipient must act', () => {
    for (const wording of [
      // Done, or the carrier's own step.
      'Duties and Taxes paid', 'Payment received', 'Tax ID: TAX ID OK', 'Customs document required uploaded',
      'Documents and information required for clearance have been received by the carrier.',
      // Whoever must act is not named, or it may be the sender.
      'Awaiting payment', 'Waiting for documents', 'Waiting for Invoice', 'Customs document missing',
      'Item held by customs for documents /information', 'Customs charges raised',
      // A longer wording around an action's is another wording.
      'Your parcel will be released from customs after payment', 'Need to inform recipient\'s CPF/CNPJ again later',
      '', undefined,
    ]) expect(recipientAction(wording), String(wording)).toBeUndefined();
  });

  it('flags only the listed wordings among the carriers\' vocabularies', () => {
    const flagged: string[] = [];
    for (const carrier of readdirSync(CARRIERS).sort()) {
      let records: { entries?: { wording?: string }[] };
      try {
        records = JSON.parse(readFileSync(path.join(CARRIERS, carrier, 'statuses.json'), 'utf8'));
      } catch {
        continue;
      }
      for (const { wording } of records.entries ?? []) {
        const action = recipientAction(wording);
        if (action) flagged.push(`${carrier} ${action}: ${wording}`);
      }
    }
    expect(flagged).toEqual([
      'buffalo-ex duties: Customs VAT and duty can be paid now, please pay in time',
      'correios-br tax_id: Necessidade de informar CPF/CNPJ do destinatário',
      'omniva duties: Shipment customs payment req reminder',
      'omniva duties: A notification of additional payment for customs declaration has been sent',
      'omniva duties: Reminder of additional payment for a customs declaration',
      'saudi-post documents: Waiting for shipment documents from the customer',
      'saudi-post duties: Waiting for customs payment',
      'smsa-express duties: Shipment On Hold At Customs - Waiting To Complete Payment To Customs',
      'smsa-express documents: Delivery on Hold - Waiting Customs Info/Invoice Completion',
    ]);
  });
});
