import { normalizeRegionalGofoNumber, parseRegionalGofo } from '../gofo-fr/parser.js';
import { gofoItalyStage } from './status.js';

export const normalizeGofoItalyNumber = (raw: string) => normalizeRegionalGofoNumber(raw, 'IT');
export const parseGofoItaly = (payload: unknown, number: string) => parseRegionalGofo(payload, number, 'IT', gofoItalyStage);
