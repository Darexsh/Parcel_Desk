import { parseHTML } from 'linkedom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CARRIERS } from '../core/catalog/index.js';
import type { CarrierId } from '../generated/catalog.js';
import { carriersWithoutSearchPage, countNumberFields, FIELD_SELECTOR, uncheckedSearchPages } from './trackingSearchPages.js';

/** The fields the check counts in a page body. A field is laid out unless it is marked hidden. */
function numberFields(body: string): number {
  const { document } = parseHTML(`<html><body>${body}</body></html>`);
  const elements = [...document.querySelectorAll(FIELD_SELECTOR)];
  for (const element of elements) {
    const size = element.hasAttribute('data-hidden') ? 0 : 40;
    element.getBoundingClientRect = () => ({ width: size * 5, height: size }) as DOMRect;
  }
  vi.stubGlobal('getComputedStyle', () => ({ visibility: 'visible' }));
  return countNumberFields(elements);
}

describe('carrier search pages', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('counts a tracking field, including the editable box a tag widget draws over its text area', () => {
    expect(numberFields('<input type="text" placeholder="Tracking number">')).toBe(1);
    expect(numberFields('<tags><span contenteditable="" role="textbox"></span></tags><textarea data-hidden></textarea>')).toBe(1);
  });

  it('skips hidden, disabled, sign-in and site search fields, and boxes that are not editable text fields', () => {
    expect(numberFields([
      '<input type="text" data-hidden>',
      '<input type="text" disabled>',
      '<input type="text" name="email">',
      '<input type="text" name="q" placeholder="Search">',
      '<input type="checkbox">',
      '<span contenteditable="false" role="textbox"></span>',
      '<div contenteditable=""></div>',
    ].join(''))).toBe(0);
    expect(numberFields('<input type="search" name="q" placeholder="Search by tracking number">')).toBe(1);
    // Mongol Infinity Post names its field q and asks for the parcel's number in Mongolian.
    expect(numberFields('<input type="text" name="q" placeholder="Илгээмжийн дугаараа оруулна уу!">')).toBe(1);
  });

  it('names a search page for every carrier with a tracking link, or says why it has none', () => {
    const missing = Object.values(CARRIERS)
      .filter((carrier) => carrier.trackingUrl && !carrier.trackingSearchUrl && !carriersWithoutSearchPage[carrier.id])
      .map((carrier) => carrier.id);
    expect(missing, 'Add portal.searchUrl to carrier.json or a reason to carriersWithoutSearchPage').toEqual([]);
  });

  it('keeps reasons only for carriers without a search page', () => {
    for (const carrier of Object.keys(carriersWithoutSearchPage) as CarrierId[]) {
      expect(CARRIERS[carrier].trackingSearchUrl, carrier).toBeUndefined();
    }
  });

  it('keeps exclusions from the weekly check only for carriers with a search page', () => {
    for (const carrier of Object.keys(uncheckedSearchPages) as CarrierId[]) {
      expect(CARRIERS[carrier].trackingSearchUrl, carrier).toBeDefined();
    }
  });
});
