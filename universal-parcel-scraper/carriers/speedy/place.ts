import { clean } from '../../core/transport/text.js';

/**
 * A scan's place opens with its site's type in English, `gr.` for a Bulgarian town or `or.` for a
 * Romanian one, and a partner's with a numeric site code; the town and country are kept.
 */
export const speedyPlace = (value: unknown) => clean(value, 160).replace(/^\d+\s*-\s*/, '').replace(/^[a-z]{1,4}\.\s+(?=\S)/, '');
