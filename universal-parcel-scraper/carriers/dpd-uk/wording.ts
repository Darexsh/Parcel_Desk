// The driver's name after "Your driver", as in "Your driver Sample won't be back today".
const DRIVER = /\b(your driver)\s+(?!(?:won['’]t|will|is|has|was|tried|couldn['’]t)\b)[^.,;!?]{1,60}?(?=\s+(?:won['’]t|will|is|has|was|tried|couldn['’]t)\b)/gi;

/** A sentence without the driver's name it gives. */
export function withoutDriverName(sentence: string): string {
  return sentence.replace(DRIVER, '$1');
}

/**
 * A sentence as DPD UK's map reads it: in lower case with straight apostrophes and single
 * spaces, without its closing full stop, the time of its scan the summary appends, or the hour
 * the round's notice gives for the delivery and later drops.
 */
export function dpdUkWording(sentence: string): string {
  return sentence.toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, ' ').trim()
    .replace(/ at (?:[01]?\d|2[0-3]):[0-5]\d on [a-z]{3} \d{1,2} [a-z]+ \d{4}$/, '').replace(/[.!]+$/, '')
    .replace(/^(your parcel will be with you today) between (?:[01]?\d|2[0-3]):[0-5]\d and (?:[01]?\d|2[0-3]):[0-5]\d$/, '$1');
}
