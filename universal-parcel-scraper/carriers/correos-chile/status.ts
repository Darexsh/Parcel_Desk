import type { ClassifiedStatus } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

function comparable(value: string): string {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();
}

const TRANSIT: ClassifiedStatus = { status: 'in_transit', stage: 'in_transit' };

// Scans of a parcel leaving Chile and of the legs before delivery, as providers and an
// open-source client relay them, without the portal's code. The whole wording must match.
const WORDINGS: ReadonlyMap<string, ClassifiedStatus> = new Map([
  ['RECIBIDO POR CORREOSCHILE', { status: 'in_transit', stage: 'accepted' }],
  ['RECIBIDO EN PLANTA DE ORIGEN', TRANSIT],
  ['RECIBIDO EN PLANTA ORIGEN', TRANSIT],
  ['ENVIO DESPACHADO', TRANSIT],
  ['DESPACHADO A OFICINA DE CORREOSCHILE', TRANSIT],
  ['RECIBIDO EN OFICINA DE CORREOSCHILE', TRANSIT],
  ['DISPONIBLE PARA SALIR AL PAIS DE DESTINO', TRANSIT],
  ['ENVIO DESPACHADO AL PAIS DE DESTINO', TRANSIT],
  ['ENVIO INGRESA A PAIS DE DESTINO', TRANSIT],
  ['RECEPCION INTERNACIONAL POR CORREOSCHILE', TRANSIT],
  // The destination country's import, after the parcel entered it.
  ['ENVIO EN PROCESO DE INTERNACION', { status: 'in_transit', stage: 'customs' }],
]);

/** Only actual scan wording establishes progress; the portal also sends future rail markers. */
export function classifyCorreosChileScan(code: string, wording: string): ClassifiedStatus | null {
  const label = comparable(wording);
  if (code === '001' && label === 'ENVIO ADMITIDO') {
    return { status: 'in_transit', stage: 'accepted' };
  }
  if (code === '003' && label === 'ENVIO EN PROCESO DE INTERNACION AL PAIS') {
    return { status: 'in_transit', stage: 'customs' };
  }
  if (code === '005' && label === 'ENVIO EN REPARTO') {
    return { status: 'out_for_delivery', stage: 'out_for_delivery' };
  }
  if ((code === '006' || code === '010') && label === 'ENVIO ENTREGADO') {
    return { status: 'delivered', stage: 'delivered' };
  }
  return WORDINGS.get(label) ?? null;
}

/** The wording the parser gives a scan in place of free-form status text, kept out of public histories. */
export const NEUTRAL_UPDATE = 'Actualización del envío';

/**
 * What the map says about one scan: its wording, with the portal's code where a stage needs it,
 * as the parser reads them. The neutral update in place of free-form wording is a gap: the stored
 * scan keeps none of the wording it replaced, and the portal's code alone does not tell a stage.
 */
const NEUTRAL_GAP = 'Free-form status text the parser replaces for privacy; the stored scan keeps none of it to map.';

export const statusMap: CarrierStatusMap = {
  // Gaps read the portal's icon codes as one: the neutral update comes with any of them, or none.
  codeKey: (code) => (/^\d{1,3}$/.test(code) ? 'icon' : code),
  stage: (code, wording) => classifyCorreosChileScan(code ?? '', wording)?.stage,
  gaps: [{ code: 'icon', wording: normalizeStatusWording(NEUTRAL_UPDATE), note: NEUTRAL_GAP },
    { wording: normalizeStatusWording(NEUTRAL_UPDATE), note: NEUTRAL_GAP }],
};
