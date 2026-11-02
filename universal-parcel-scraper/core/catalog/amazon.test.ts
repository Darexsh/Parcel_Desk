import { describe, expect, it } from 'vitest';
import { amazonMarketplace, amazonOrdersUrl } from './amazon.js';
import { parcelTrackingLinks } from './parcel.js';

describe('Amazon order-history store', () => {
  it('follows the number\'s country, or where Amazon sends that country\'s visitors', () => {
    expect(amazonOrdersUrl('CH1234567890')).toBe('https://www.amazon.de/gp/your-account/order-history');
    expect(amazonOrdersUrl('FR1234567890')).toBe('https://www.amazon.fr/gp/your-account/order-history');
    expect(['LI', 'LU', 'DK', 'NO', 'FI', 'CZ', 'GR'].map((prefix) => amazonMarketplace(`${prefix}1234567890`))).toEqual(Array(7).fill('de'));
    expect(amazonMarketplace('IS1234567890')).toBe('co.uk');
    // A delivery country never overrides the country a number names.
    expect(amazonMarketplace('CH1234567890', 'CA')).toBe('de');
    expect(amazonMarketplace('SK1234567890')).toBe('com');
  });

  it('lets the delivery country choose the store for TBA numbers and no number', () => {
    expect(amazonOrdersUrl('TBA123456789012', 'CA')).toBe('https://www.amazon.ca/gp/your-account/order-history');
    expect(amazonMarketplace('TBA123456789012', ' ca ')).toBe('ca');
    expect(amazonMarketplace('TBA123456789012')).toBe('com');
    expect(amazonMarketplace('TBA123456789012', 'FR')).toBe('com');
    expect(amazonMarketplace('TBC123456789012', 'US')).toBe('ca');
    expect(amazonMarketplace('TBM123456789012', 'CA')).toBe('com.mx');
    expect(amazonMarketplace('', 'CH')).toBe('de');
    expect(amazonMarketplace('', 'CA')).toBe('ca');
    expect(amazonMarketplace('')).toBe('com');
  });

  it('links a parcel delivered in Canada under TBA to amazon.ca', () => {
    const parcel = { carrier: 'amazon-logistics' as const, trackingNumber: 'TBA123456789012' };
    expect(parcelTrackingLinks({ ...parcel, destinationCountry: 'CA' })[0]?.url).toBe('https://www.amazon.ca/gp/your-account/order-history');
    expect(parcelTrackingLinks(parcel)[0]?.url).toBe('https://www.amazon.com/gp/your-account/order-history');
  });
});
