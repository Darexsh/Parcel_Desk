import { townKey } from '../../core/time/index.js';

// India's states and union territories, and the country: a row placed in one keeps India's clock.
const INDIA = new Set([
  'india', 'andhrapradesh', 'arunachalpradesh', 'assam', 'bihar', 'chhattisgarh', 'goa', 'gujarat', 'haryana',
  'himachalpradesh', 'jharkhand', 'karnataka', 'kerala', 'madhyapradesh', 'maharashtra', 'manipur', 'meghalaya',
  'mizoram', 'nagaland', 'odisha', 'orissa', 'punjab', 'rajasthan', 'sikkim', 'tamilnadu', 'telangana', 'tripura',
  'uttarpradesh', 'uttarakhand', 'uttaranchal', 'westbengal', 'andamanandnicobarislands', 'chandigarh',
  'dadraandnagarhavelianddamananddiu', 'delhi', 'newdelhi', 'ncr', 'jammuandkashmir', 'ladakh', 'lakshadweep',
  'puducherry', 'pondicherry',
].map(townKey));

/**
 * The domestic courier's place in India: a hub with its state in brackets,
 * "Gurgaon_Hub (Haryana)", or a place whose last part is a state, "DELHI".
 */
export function placedInIndia(location: string): boolean {
  const state = /\(([^()]+)\)$/.exec(location)?.[1] ?? location.split(',').at(-1) ?? '';
  return INDIA.has(townKey(state));
}
