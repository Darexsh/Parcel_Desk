import { lexAdapter } from './lex.js';
import { LEX_ID } from './parser.js';

export const adapter = lexAdapter(LEX_ID);
