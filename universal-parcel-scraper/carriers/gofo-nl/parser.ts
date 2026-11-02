import { normalizeRegionalGofoNumber, parseRegionalGofo } from '../gofo-fr/parser.js';
import { gofoNetherlandsStage } from './status.js';

export const normalizeGofoNetherlandsNumber = (raw: string) => normalizeRegionalGofoNumber(raw, 'NL');
export const parseGofoNetherlands = (payload: unknown, number: string) => parseRegionalGofo(payload, number, 'NL', gofoNetherlandsStage);
