import type { CarrierResult } from '../../core/result/index.js';
import { normalizeControlboxNumber, parseControlboxGuide, type ControlboxTenant } from './controlbox.js';
import { vimenpaqStage } from './status.js';

export const PROVIDER = 'Vimenpaq';
/** Vimenpaq's customer API on ControlBox, which the tracking page of its app asks. */
export const VIMENPAQ_API = 'https://ssl3.controlbox.net:8443/vimenpaq/APIVimenpaqClientes/api';
export const VIMENPAQ: ControlboxTenant = { carrier: 'vimenpaq', provider: PROVIDER, api: VIMENPAQ_API, stage: vimenpaqStage };

export const normalizeVimenpaqNumber = (raw: string): string => normalizeControlboxNumber(raw, PROVIDER);
export const parseVimenpaq = (payload: unknown, number: string): CarrierResult => parseControlboxGuide(payload, number, VIMENPAQ);
