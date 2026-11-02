/** Regional families described by GOFO's national support pages. */
export type GofoRegion = 'FR' | 'IT' | 'NL' | 'ES';

export function isRegionalGofoWaybill(number: string, region: GofoRegion): boolean {
  return new RegExp(`^(?:GF|CI)${region}\\d{13,14}$`).test(number);
}

export function isRegionalGofoNumber(number: string, region: GofoRegion): boolean {
  return isRegionalGofoWaybill(number, region) || region === 'FR' && /^PK\d{20}$/.test(number);
}

/** The French public request builder preserves a shipper reference's hyphens. */
export function regionalGofoRequestNumber(number: string): string {
  return /^PK\d{20}$/.test(number) ? `PK-${number.slice(2, -1)}-${number.slice(-1)}` : number;
}
