import { normalizeRegionalGofoNumber, parseRegionalGofo } from '../gofo-fr/parser.js';
import { gofoSpainStage } from './status.js';

export const normalizeGofoSpainNumber = (raw: string) => normalizeRegionalGofoNumber(raw, 'ES');
export const parseGofoSpain = (payload: unknown, number: string) => parseRegionalGofo(payload, number, 'ES', gofoSpainStage);
