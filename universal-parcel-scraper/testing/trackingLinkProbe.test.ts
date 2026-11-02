import { describe, expect, it } from 'vitest';
import { searchPageVerdict, trackingPageVerdict } from './trackingLinkProbe.js';

const route = /^https:\/\/carrier\.example\/tracking(?:\?|$)/;
const marker = /track your parcel/i;
const page = { status: 200, url: 'https://carrier.example/tracking?number=SYNTHETIC1',
  title: 'Parcel tracker', text: 'Track your parcel. Shipment not found.' };

describe('tracking link page validation', () => {
  it('accepts an actual tracker with an unknown/expired shipment', () => {
    expect(trackingPageVerdict(page, route, marker)).toBe('tracking-page');
  });
  it.each([404, 410, 500, 503])('rejects HTTP %s even with a tracking marker', (status) => {
    expect(trackingPageVerdict({ ...page, status }, route, marker)).toBe('broken');
  });
  it('accepts an observed shipment-absence status only with its specific message on the tracker route', () => {
    const absence = { status: 404 as const, marker: /Shipment not found/ };
    expect(trackingPageVerdict({ ...page, status: 404 }, route, marker, absence)).toBe('tracking-page');
    expect(trackingPageVerdict({ ...page, status: 404, text: 'Track your parcel' }, route, marker, absence)).toBe('broken');
    expect(trackingPageVerdict({ ...page, status: 404, url: 'https://carrier.example/' }, route, marker, absence)).toBe('broken');
    expect(trackingPageVerdict({ ...page, status: 410 }, route, marker, absence)).toBe('broken');
  });
  it('does not mistake an ordinary reCAPTCHA footer for a challenge', () => {
    expect(trackingPageVerdict({ ...page, text: page.text + ' Protected by reCAPTCHA.' }, route, marker))
      .toBe('tracking-page');
  });
  it('rejects a soft 404 returned with HTTP 200', () => {
    expect(trackingPageVerdict({ ...page, title: 'Page not found' }, route, marker)).toBe('broken');
  });
  it('rejects a homepage redirect even if navigation includes tracking words', () => {
    expect(trackingPageVerdict({ ...page, url: 'https://carrier.example/' }, route, marker)).toBe('broken');
  });
  it('does not count an empty SPA shell as verified', () => {
    expect(trackingPageVerdict({ ...page, text: '' }, route, marker)).toBe('unverified');
  });
  it.each([200, 403, 429])('reports a challenge (%s) as blocked, never healthy', (status) => {
    expect(trackingPageVerdict({ ...page, status, title: 'Just a moment...' }, route, marker)).toBe('blocked');
  });
  it('reports Amazon\'s bot check, served on the requested route, as blocked', () => {
    const signIn = /^https:\/\/www\.amazon\.com\/ap\/signin/;
    const check = { status: 200, url: 'https://www.amazon.com/ap/signin?openid.mode=checkid_setup', title: 'Amazon.com',
      text: 'Click the button below to continue shopping\nContinue shopping\nConditions of Use\nPrivacy Policy' };
    expect(trackingPageVerdict(check, signIn, /Sign in|Your Orders/i)).toBe('blocked');
  });
  it('reports LogoiX\'s bot check, served on the tracker\'s address, as blocked', () => {
    const check = { status: 200, url: 'https://www.logoix.com/cgi-bin/tnt.pl?q=LIX9000000003',
      title: 'LogoiX - deutsche Lieferadresse, Paketversand und Weiterleitung EU-weit, Lager und Versandservice',
      text: 'Track & Trace von LIX9000000003\nBitte bestätigen Sie, dass Sie kein Bot sind: :)' };
    expect(trackingPageVerdict(check, /^https:\/\/www\.logoix\.com\/cgi-bin\/tnt\.pl\?q=LIX9000000003$/,
      /Verlauf der Sendung LIX9000000003|unbekannte Sendungsnummer/)).toBe('blocked');
  });
});

describe('search page validation', () => {
  const search = { status: 200, url: 'https://carrier.example/track', title: 'Track a parcel', text: 'Enter your tracking number' };
  it('accepts a page that shows a field to type a number in', () => {
    expect(searchPageVerdict(search, 1)).toBe('search-page');
  });
  it('rejects a page with no field, such as a desktop-only form or an empty result', () => {
    expect(searchPageVerdict(search, 0)).toBe('broken');
  });
  it('leaves an empty, untitled document unverified', () => {
    expect(searchPageVerdict({ ...search, title: '', text: '' }, 0)).toBe('unverified');
    expect(searchPageVerdict({ ...search, text: '' }, 0)).toBe('broken');
  });
  it.each([404, 410, 500])('rejects HTTP %s even with a field', (status) => {
    expect(searchPageVerdict({ ...search, status }, 1)).toBe('broken');
  });
  it('rejects a soft 404 that keeps the site search', () => {
    expect(searchPageVerdict({ ...search, title: 'Page not found' }, 1)).toBe('broken');
  });
  it.each([403, 412, 429])('reports a challenge (%s) as blocked, never healthy', (status) => {
    expect(searchPageVerdict({ ...search, status, title: 'Access Denied' }, 0)).toBe('blocked');
  });
  it('keeps a field shown above a human check', () => {
    expect(searchPageVerdict({ ...search, text: 'Enter your tracking number. Verify you are human.' }, 1)).toBe('search-page');
  });
});
