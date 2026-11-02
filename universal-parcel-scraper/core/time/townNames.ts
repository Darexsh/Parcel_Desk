/**
 * Country names in German, French, Italian, Spanish, Dutch, Portuguese or
 * Polish that towns of 15,000 or more people also bear: "Granada" is Grenada
 * in Spanish, "França" France in Portuguese. They name the town as often as
 * the country, so only the English name reads as the country.
 */
const TOWN_NAMES = new Set(['ALAND', 'FRANCA', 'GRANADA', 'GUADALUPE', 'LIBANO', 'NORFOLK', 'SAINT-BARTHELEMY', 'SALVADOR',
  'SAN BARTOLOME', 'SAN MARTIN', 'SANTA ELENA', 'SANTA HELENA', 'SANTA LUCIA', 'SAO MARTINHO', 'SINGAPUR', 'TAILANDIA',
  'WŁOCHY']);

/** Whether a country's name in another language is also a large town's, without regard to case, accents or spacing. */
export function townName(name: string): boolean {
  return TOWN_NAMES.has(name.normalize('NFD').replace(/\p{Mn}/gu, '').toUpperCase().replace(/\s+/g, ' ').trim());
}
