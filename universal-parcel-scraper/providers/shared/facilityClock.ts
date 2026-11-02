import { facilityZone } from '../../carriers/dhl-express/clock.js';
import { carrierIdFromName } from '../../core/catalog/hints.js';
import { IndeterminateError } from '../../core/errors/index.js';
import type { UniversalSource } from './result.js';

/**
 * DHL Express dates a scan with its facility's clock and no offset, and the
 * providers relay that clock under a label of their own: UTC at ParcelsApp, one
 * offset for the whole parcel at 17TRACK. Ship24 relays it with the facility's
 * offset, and DHL's mobile API gives the same clocks scan for scan (checked
 * 2026-10-06). So such a scan is read in its facility's zone, and with no zone
 * for the facility it is a wall time that no label makes an instant.
 */
export function relaysFacilityClock(carrierName: unknown): boolean {
  return typeof carrierName === 'string' && carrierIdFromName(carrierName) === 'dhl-express';
}

export { facilityZone };

/**
 * The newest wall clock of a reply, and whether that scan was left without an
 * instant. A reply whose latest scan has none cannot say where the parcel is,
 * and an older scan must not stand in for it.
 */
export class LatestScan {
  private wall = '';
  private unplaced = false;
  private network = '';
  constructor(private readonly source: UniversalSource) {}

  see(wall: string, unplaced: boolean, network = 'DHL Express'): void {
    if (wall > this.wall || (wall === this.wall && unplaced)) [this.wall, this.unplaced, this.network] = [wall, unplaced, network];
  }

  check(): void {
    if (this.unplaced) throw new IndeterminateError(this.source, `${this.source} cannot place the latest ${this.network} scan`);
  }
}
