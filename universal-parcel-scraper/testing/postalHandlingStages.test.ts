import { describe, expect, it } from 'vitest';
import { classifyWording } from '../core/status/index.js';
import { event } from '../providers/shared/result.js';

const TIME = '2026-01-01T12:00:00Z';

describe('postal handling labels in universal histories', () => {
  it.each([
    ['Customs has released the goods', 'in_transit'],
    ['Item accepted from transport', 'in_transit'],
    ['Item has been registered', 'in_transit'],
    ['Item has been registered The item can be registered several times during delivery.', 'in_transit'],
    ['Item has arrived to destination country The item has reached the target country. If it needs to be customs cleared, instructions are sent. Otherwise it is delivered to the recipient.', 'in_transit'],
    ['Item is ready for delivery in destination country', 'in_transit'],
    ['Item in process in office of exchange', 'in_transit'],
    ['Item in process in office of exchange. The item is being processed in the international terminal.', 'in_transit'],
    ['Acceptance of incoming shipment at the exchange office', 'in_transit'],
    ['Item received for transport', 'accepted'],
    ['Your package has been dropped off by the sender at our postal partner in its country of origin.', 'accepted'],
    ['The item is on its way to the destination country.', 'in_transit'],
    ['Load Vehicle', 'in_transit'],
    ['Scan Ok Gateway', 'in_transit'],
  ])('recognizes %s', (description, stage) => {
    expect(event(TIME, description)?.stage).toBe(stage);
  });

  it('keeps customs negation, forecasts and generic registration separate', () => {
    for (const description of ['Customs has not released the goods', 'Customs will release the goods']) {
      expect(classifyWording(description).stage).toBe('customs');
      expect(event(TIME, description)?.stage).toBe('customs');
    }
    expect(event(TIME, 'Item has been registered electronically')?.stage).toBe('registered');
    expect(event(TIME, 'Item accepted from transport. Delivery failed')?.stage).toBe('failed_attempt');
    expect(event(TIME, 'Shipment registered')?.stage).toBe('pending');
    expect(event(TIME, 'Livraison prévue lundi prochain')?.stage).toBe('pending');
    expect(event(TIME, 'Load vehicle tomorrow')?.stage).toBe('pending');
  });
});
