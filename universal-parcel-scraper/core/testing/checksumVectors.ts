/**
 * The checksum test vectors.
 *
 * What it is: generated inputs for every checksum a detection rule can name,
 * each with the answer its validator gives, frozen as
 * `data/checksum-vectors.json` so the Swift port can replay them. The
 * detection golden file only reaches corpus numbers; these also reach the
 * edges of each check.
 * What it is not: real tracking numbers or a second implementation. Inputs come
 * from a seeded generator, valid ones by completing their check character, and
 * every answer comes from `CHECKSUMS`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHECKSUMS, type ChecksumId } from '../detection/checksums.js';
import { hasGs1CheckDigit, mod11CheckDigit } from '../detection/numericChecksums.js';

export type ChecksumVector = readonly [input: string, valid: boolean];

export interface ChecksumVectors {
  readonly version: 1;
  readonly vectors: Readonly<Record<ChecksumId, readonly ChecksumVector[]>>;
}

const testingDirectory = path.dirname(fileURLToPath(import.meta.url));
export const VECTORS_PATH = path.resolve(testingDirectory, '../../data/checksum-vectors.json');

const DIGITS = '0123456789';
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const ALNUM = DIGITS + LETTERS;
const HEX = '0123456789ABCDEF';
const S10_WEIGHTS = [8, 6, 4, 2, 3, 5, 9, 7];

/** mulberry32: small, seedable and the same on every platform. */
function generator(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a of the id, so editing one recipe leaves the others' draws alone. */
function seedOf(id: string): number {
  let hash = 0x811c9dc5;
  for (const character of id) hash = Math.imul(hash ^ character.charCodeAt(0), 0x01000193);
  return hash >>> 0;
}

/** Steers a draw to one branch of a check, such as a remainder of 10; the answers still come from the validators. */
function weightedSum(digits: string, weights: readonly number[]): number {
  return [...digits].reduce((total, digit, index) => total + Number(digit) * weights[index % weights.length]!, 0);
}

const mod11Sum = (digits: string) => weightedSum([...digits].reverse().join(''), [2, 3, 4, 5, 6, 7]);
const replaceAt = (value: string, index: number, character: string) => value.slice(0, index) + character + value.slice(index + 1);
const pad = (value: number) => String(value).padStart(2, '0');

function completeBy(test: (value: string) => boolean, head: string, tail = '', alphabet = DIGITS): string {
  for (const character of alphabet) if (test(head + character + tail)) return head + character + tail;
  throw new Error(`no check character completes ${head}…${tail}`);
}

class Recipe {
  private readonly draw: () => number;
  private readonly answers = new Map<string, boolean>();

  constructor(readonly id: ChecksumId) {
    this.draw = generator(seedOf(id));
  }

  int(below: number): number {
    return Math.floor(this.draw() * below);
  }

  pick(characters: string): string {
    return characters[this.int(characters.length)]!;
  }

  string(length: number, characters = DIGITS): string {
    let value = '';
    for (let index = 0; index < length; index++) value += this.pick(characters);
    return value;
  }

  /** The head, the first character of the alphabet that makes the input valid, then the tail. */
  complete(head: string, tail = '', alphabet = DIGITS): string {
    return completeBy(CHECKSUMS[this.id], head, tail, alphabet);
  }

  /** Every digit that closes the head. */
  completions(head: string): string[] {
    return [...DIGITS].filter((digit) => CHECKSUMS[this.id](head + digit));
  }

  find(draw: () => string, test: (value: string) => boolean): string {
    for (let attempt = 0; attempt < 10_000; attempt++) {
      const value = draw();
      if (test(value)) return value;
    }
    throw new Error(`${this.id}: no draw reached the branch`);
  }

  add(...inputs: string[]): void {
    for (const input of inputs) if (!this.answers.has(input)) this.answers.set(input, CHECKSUMS[this.id](input));
  }

  vectors(): ChecksumVector[] {
    return [...this.answers];
  }
}

/** A different character of the same kind. */
function substitute(recipe: Recipe, value: string, index: number): string {
  const current = value[index]!;
  return replaceAt(value, index, recipe.pick((/\d/.test(current) ? DIGITS : LETTERS).replace(current, '')));
}

/**
 * The cases every checksum gets: the valid inputs, single-character mutations,
 * wrong lengths, letters where digits belong, boundaries and a few inputs that
 * normalization would have changed. The first valid input seeds the shape cases.
 */
function standard(recipe: Recipe, valid: readonly string[], check = -1): void {
  recipe.add(...valid);
  for (const value of valid.slice(0, 4)) recipe.add(substitute(recipe, value, check < 0 ? value.length + check : check));
  for (let index = 0; index < 6; index++) {
    const value = valid[index % valid.length]!;
    recipe.add(substitute(recipe, value, recipe.int(value.length)));
  }

  const first = valid[0]!;
  const checkIndex = check < 0 ? first.length + check : check;
  recipe.add(first.slice(0, -1), first + recipe.pick(DIGITS), first.slice(1), recipe.pick(DIGITS) + first);
  const fromMiddle = [...first].map((_, index) => (index + Math.floor(first.length / 2)) % first.length);
  const digitIndex = fromMiddle.find((index) => index !== checkIndex && /\d/.test(first[index]!));
  if (digitIndex !== undefined) recipe.add(replaceAt(first, digitIndex, 'O'));
  if (/\d/.test(first[checkIndex]!)) recipe.add(replaceAt(first, checkIndex, 'A'));
  recipe.add('0'.repeat(first.length), '9'.repeat(first.length), '');

  if (/[A-Z]/.test(first)) recipe.add(first.toLowerCase());
  recipe.add(`${first.slice(0, 4)} ${first.slice(4)}`);
  recipe.add(first.replace(/\d/, (digit) => String.fromCharCode(0x0660 + Number(digit))));
  // JavaScript's `$` is the end of the input, and its `\s` holds U+FEFF but not U+0085.
  recipe.add(`${first}\n`, `\uFEFF${first}`, `${first.slice(0, 4)}\u0085${first.slice(4)}`);
}

const RECIPES: Record<ChecksumId, (recipe: Recipe) => void> = {
  colissimo(r) {
    const valid = ['6A', '6C', '6L', '8R', '8V', '5N', '5W', '6Y'].map((code) => r.complete(code + r.string(10)));
    standard(r, valid);
    // The product code is outside the key.
    const digits = valid[0]!.slice(2);
    r.add(`00${digits}`, `ZZ${digits}`, `6${digits}`, `6AB${digits}`);
    r.add(r.complete(`6A${'0'.repeat(10)}`), r.complete(`8R${'9'.repeat(10)}`));
  },

  'correos-spain'(r) {
    const letter = (head: string) => r.complete(head, '', LETTERS);
    const code = (prefix: string, digits: number) => letter(`${prefix}${r.string(4, ALNUM)}${r.string(digits)}`);
    const valid = [
      code(`P${r.pick(LETTERS)}`, 16), code(`P${r.pick(LETTERS)}`, 16), code(`D${r.pick(LETTERS)}`, 16), code('CD', 16),
      code(`P${r.pick(LETTERS)}`, 9), code(`D${r.pick(LETTERS)}`, 9), code('PQ', 9),
    ];
    standard(r, valid);
    // Only the sum of the character codes counts: a swap keeps the letter, and
    // so does a letter 23 code points away.
    const first = valid[0]!;
    r.add(`${first[1]}${first[0]}${first.slice(2)}`);
    const traded = code('PA', 16);
    r.add(traded, `PX${traded.slice(2)}`);
    // The table holds no I, O or U, and no digit.
    r.add(...['I', 'O', 'U', '0'].map((character) => first.slice(0, -1) + character));
    r.add(letter('A'), 'A', letter('0'), letter(`PQ${'0'.repeat(20)}`));
  },

  'dhl-express'(r) {
    const valid = Array.from({ length: 8 }, () => r.complete(r.string(9)));
    standard(r, valid);
    // A remainder of seven is never 7, 8 or 9.
    const head = valid[0]!.slice(0, -1);
    r.add(`${head}7`, `${head}8`, `${head}9`);
    r.add(r.complete('000000007'), '0000000007', r.complete('9'.repeat(9)));
  },

  dpd(r) {
    const check = (head: string) => r.complete(head, '', ALNUM);
    // MOD 37,36 closes with a letter about seven times in ten: keep both kinds.
    const letters: string[] = [];
    const digits: string[] = [];
    while (letters.length < 5 || digits.length < 3) {
      const value = check(r.string(14));
      if (/\d$/.test(value)) { if (digits.length < 3) digits.push(value); } else if (letters.length < 5) letters.push(value);
    }
    // La Poste and Chronopost print the character after 870 and 880 numbers.
    const valid = [...letters, ...digits, check(`870${r.string(11)}`), check(`880${r.string(11)}`)];
    standard(r, valid);
    for (const last of ['0', 'A', 'Z']) r.add(r.find(() => check(r.string(14)), (value) => value.endsWith(last)));
    r.add(check('0'.repeat(14)), check('9'.repeat(14)));
  },

  evri(r) {
    const valid = [
      ...Array.from({ length: 3 }, () => r.complete(`H${r.string(5, ALNUM)}${r.string(9)}`)),
      ...Array.from({ length: 3 }, () => r.complete(`T${r.string(5, ALNUM)}${r.string(9)}`)),
      r.complete(`H${r.string(5, LETTERS)}${r.string(9)}`),
      r.complete(`T${r.string(5)}${r.string(9)}`),
    ];
    standard(r, valid);
    // Letters count as in UPS numbers: A, K and U are 2, I and S are 0, Z is 7.
    const weighed = r.complete(`HAISZB${r.string(9)}`);
    const trades: [number, string][] = [[1, '2'], [1, 'K'], [1, 'U'], [1, 'B'], [2, '0'], [3, 'I'], [4, '7']];
    r.add(weighed, ...trades.map(([index, character]) => replaceAt(weighed, index, character)));
    // J counts as T does, but only H and T open a number.
    const tee = valid[3]!;
    r.add(`J${tee.slice(1)}`, `H${tee.slice(1)}`);
    // The check is the sum mod 10, not its complement.
    const uneven = valid.find((value) => !/[05]$/.test(value))!;
    r.add(uneven.slice(0, -1) + String((10 - Number(uneven.at(-1))) % 10));
    r.add(replaceAt(valid[0]!, 10, 'A'));
  },

  fedex(r) {
    const valid = Array.from({ length: 8 }, () => r.complete(r.string(11)));
    standard(r, valid);
    // The sum mod 11, then mod 10: a remainder of 10 closes with 0.
    const ten = r.find(() => r.string(11), (head) => weightedSum(head, [3, 1, 7]) % 11 === 10);
    r.add(`${ten}0`, `${ten}1`, r.complete('9'.repeat(11)));
  },

  'fedex-1d'(r) {
    // The product index and the other digits, two zeros, then a twelve-digit FedEx number.
    const twelve = (head: string) => completeBy(CHECKSUMS.fedex, head);
    const valid = [
      ...Array.from({ length: 4 }, () => `${r.string(20)}00${twelve(r.string(11))}`),
      `1${r.string(19)}00${twelve(r.string(11))}`,
      `9622${r.string(16)}00${twelve(r.string(11))}`,
      `9632${r.string(16)}00${twelve(r.string(11))}`,
      `0${r.string(19)}00${twelve(r.string(11))}`,
    ];
    standard(r, valid);
    // Only the last twelve digits are checked; the two before them must be zeros,
    // even where the barcode's 13-digit check would still pass (4 + 7 × 1 = 11).
    const first = valid[0]!;
    r.add(`${r.string(20)}${first.slice(20)}`, `${first.slice(0, 20)}41${first.slice(22)}`, `${first.slice(0, 20)}01${first.slice(22)}`);
    r.add(`${first.slice(0, 20)}${first.slice(22)}`, first.slice(22), `${first.slice(0, 20)}000${first.slice(22)}`);
    // The sum mod 11, then mod 10: a remainder of 10 closes with 0.
    const ten = r.find(() => r.string(11), (head) => weightedSum(head, [3, 1, 7]) % 11 === 10);
    const head = r.string(20);
    r.add(`${head}00${ten}0`, `${head}00${ten}1`, `${head}00${twelve('9'.repeat(11))}`);
  },

  'fedex-ground-economy'(r) {
    // A USPS package identifier without its 92 channel: a service type code, a
    // Mailer ID starting with 9 and the serial, closed by the identifier's check.
    const valid = [
      ...Array.from({ length: 3 }, () => r.complete(`6129${r.string(15)}`)),
      ...Array.from({ length: 3 }, () => r.complete(`7489${r.string(15)}`)),
      r.complete(r.string(19)),
      r.complete(r.string(19)),
    ];
    standard(r, valid);
    // The check counts the 92 in front: a check over the twenty digits alone, or
    // with another channel in front, proves nothing.
    const head = r.string(19);
    r.add(completeBy(hasGs1CheckDigit, head), completeBy((value) => hasGs1CheckDigit(`91${value}`), head),
      completeBy((value) => hasGs1CheckDigit(`93${value}`), head));
    // The 22-digit identifier is not the twenty-digit number.
    const first = valid[0]!;
    r.add(`92${first}`, `92${first.slice(0, -1)}`);
    r.add(r.complete('0'.repeat(19)), r.complete('9'.repeat(19)));
  },

  'fedex-ground-96'(r) {
    // 96, a two-digit SCNC and a three-digit service code, then the fifteen-digit Ground number.
    const ground = (head: string) => completeBy(hasGs1CheckDigit, head);
    const valid = [
      ...Array.from({ length: 6 }, () => `961${r.pick('123')}${r.string(3)}${ground(r.string(14))}`),
      `96${r.string(5)}${ground(r.string(14))}`,
      `96${r.string(5)}${ground(r.string(14))}`,
    ];
    standard(r, valid);
    // The check covers the last fifteen digits only: the five before them are free, and
    // a GS1 check over all 22 digits proves nothing.
    const first = valid[0]!;
    r.add(`96${r.string(5)}${first.slice(7)}`, `95${first.slice(2)}`, `69${first.slice(2)}`, first.slice(7));
    r.add(r.find(() => ground(`96${r.string(19)}`), (value) => !CHECKSUMS['fedex-ground-96'](value)));
    // A check digit of 0.
    r.add(r.find(() => `96${r.string(5)}${ground(r.string(14))}`, (value) => value.endsWith('0')));
    r.add(`9600000${ground('0'.repeat(14))}`, `9699999${ground('9'.repeat(14))}`);
  },

  gls(r) {
    const valid = Array.from({ length: 8 }, () => r.complete(r.string(11)));
    standard(r, valid);
    // The sum starts at one, so the plain EAN digit, one higher, fails.
    const first = valid[0]!;
    r.add(first.slice(0, -1) + String((Number(first.at(-1)) + 1) % 10));
    r.add(r.complete('0'.repeat(11)), r.complete('9'.repeat(11)));
  },

  gs1(r) {
    const valid = [16, 16, 23, 23, 2, 8, 13, 14, 18, 30].map((length) => r.complete(r.string(length - 1)));
    standard(r, valid);
    r.add('0', '00', '05', r.complete('9'.repeat(15)), r.complete('0'.repeat(22)));
  },

  hermes(r) {
    const valid = Array.from({ length: 8 }, () => r.complete(r.string(13)));
    standard(r, valid);
    r.add(r.complete('0'.repeat(13)), r.complete('9'.repeat(13)));
  },

  identcode(r) {
    const valid = Array.from({ length: 8 }, () => r.complete(r.string(11)));
    standard(r, valid);
    // Weights 4 and 9 from the left: a sum that is a multiple of ten closes with 0, and
    // starting with 9 instead gives another digit.
    const zero = r.find(() => r.string(11), (head) => weightedSum(head, [4, 9]) % 10 === 0);
    r.add(`${zero}0`, `${zero}1`);
    const head = r.find(() => r.string(11), (digits) => weightedSum(digits, [4, 9]) % 10 !== weightedSum(digits, [9, 4]) % 10);
    r.add(head + String((10 - weightedSum(head, [9, 4]) % 10) % 10));
    r.add(r.complete('0'.repeat(11)), r.complete('9'.repeat(11)));
  },

  'dhl-ecommerce-pl'(r) {
    const valid = Array.from({ length: 8 }, () => r.complete(r.string(10)));
    standard(r, valid);
    // The Identcode's weights over ten digits, so the digit before the check weighs 9: a sum
    // that is a multiple of ten closes with 0, and weights 9, 4 give another digit.
    const zero = r.find(() => r.string(10), (head) => weightedSum(head, [4, 9]) % 10 === 0);
    r.add(`${zero}0`, `${zero}1`);
    const head = r.find(() => r.string(10), (digits) => weightedSum(digits, [4, 9]) % 10 !== weightedSum(digits, [9, 4]) % 10);
    r.add(head + String((10 - weightedSum(head, [9, 4]) % 10) % 10));
    // An Identcode is one digit longer.
    r.add(r.complete('0'.repeat(10)), r.complete('9'.repeat(10)), `${valid[0]}0`);
  },

  luhn(r) {
    const valid = [
      ...Array.from({ length: 4 }, () => r.complete(`${r.pick('0123')}${r.string(10)}`)),
      ...[2, 3, 9, 20, 30].map((length) => r.complete(r.string(length - 1))),
    ];
    standard(r, valid);
    // A doubled digit above nine counts nine less; 09 and 90 swap unseen.
    r.add('0', '00', '18', '59', '91');
    const swap = r.complete(`${r.string(4)}09${r.string(5)}`);
    r.add(swap, `${swap.slice(0, 4)}90${swap.slice(6)}`);
  },

  'magyar-posta'(r) {
    // P, a product letter, a three-character customer code, seven digits and the check digit.
    const valid = [
      ...['PN', 'PK', 'PI', 'PB'].map((prefix) => r.complete(`${prefix}${r.string(3, LETTERS)}${r.string(7)}`)),
      r.complete(`PN${r.string(3, ALNUM)}${r.string(7)}`), r.complete(`PN000${r.string(7)}`), r.complete(`P${r.pick(LETTERS)}${r.string(3)}${r.string(7)}`),
    ];
    standard(r, valid);
    // The sum mod 10 is the digit, not its complement, and the customer code is outside the check.
    const uneven = valid.find((value) => !/[05]$/.test(value))!;
    r.add(`${uneven.slice(0, 12)}${(10 - Number(uneven[12])) % 10}`);
    r.add(`${uneven.slice(0, 2)}ZZZ${uneven.slice(5)}`, `${uneven.slice(0, 2)}999${uneven.slice(5)}`);
    // Only P opens a number, a letter follows it, and the code holds no other character.
    r.add(`Q${uneven.slice(1)}`, `P1${uneven.slice(2)}`, `${uneven.slice(0, 2)}A-B${uneven.slice(5)}`);
    r.add('PAAA00000000', 'PAAA000000000', 'PAAAA00000000', 'PZZZZ99999997');
  },

  mod7(r) {
    const valid = [11, 11, 12, 12, 2, 3, 9, 15].map((length) => r.complete(r.string(length - 1)));
    standard(r, valid);
    // A remainder of seven is never 7, 8 or 9, and the number holds two to fifteen digits.
    const head = valid[0]!.slice(0, -1);
    r.add(`${head}7`, `${head}8`, `${head}9`);
    const long = r.string(15);
    r.add(`${long}${BigInt(long) % 7n}`, '0', '00', '07', '70');
  },

  'mondial-relay'(r) {
    // Brand and shipment, sequence, count, key, routing, key.
    const label = (sequence: number, count: number, routing = r.string(10)) => {
      const head = `${r.string(10)}${pad(sequence)}${pad(count)}`;
      return `${head}${mod11CheckDigit(head)}${routing}${mod11CheckDigit(routing)}`;
    };
    const valid = Array.from({ length: 6 }, () => {
      const count = 1 + r.int(99);
      return label(1 + r.int(count), count);
    });
    valid.push(label(1, 1), label(1, 99), label(99, 99), label(9, 10));
    standard(r, valid);
    // The sequence runs from 1 to the count, even when both keys hold.
    r.add(label(0, 1), label(0, 0), label(2, 1), label(10, 9), label(99, 98));
    // Each key covers its own half.
    const first = valid[0]!;
    r.add(substitute(r, first, 14), substitute(r, first, 25));
    // A mod 11 remainder of 10 or 11 gives 0.
    for (const remainder of [0, 1]) {
      const routing = r.find(() => r.string(10), (digits) => mod11Sum(digits) % 11 === remainder);
      const keyed = label(1, 2, routing);
      r.add(keyed, `${keyed.slice(0, -1)}1`);
    }
  },

  ontrac(r) {
    const valid = [...'CCCCDDDD'].map((lead) => r.complete(lead + r.string(13)));
    standard(r, valid);
    // C counts 4 and D 5, as UPS values letters. M, W and 4 count 4 too, but
    // only C and D open a number.
    const digits = valid[0]!.slice(1);
    r.add(`D${digits}`, `M${digits}`, `W${digits}`, `4${digits}`);
    r.add(r.complete(`C${'0'.repeat(13)}`), r.complete(`D${'9'.repeat(13)}`));
  },

  'frankier-id'(r) {
    // Nineteen characters and the check character, all hexadecimal on a tracked letter.
    const valid = [
      ...Array.from({ length: 5 }, () => r.complete(`A0${r.string(17, HEX)}`, '', HEX)),
      r.complete(r.string(19, HEX), '', HEX), r.complete(r.string(19), '', HEX), r.complete(`A0${'0'.repeat(17)}`, '', HEX),
    ];
    standard(r, valid);
    // The specification's own example, whose order mark and customer number hold letters past F.
    r.add('RA51251496FC301A6903', 'RA51251496FC301A6902');
    // The CRC runs over the ASCII bytes from zero without a final inversion: a check of 0 and one of F.
    const zero = r.find(() => `A0${r.string(17, HEX)}`, (head) => CHECKSUMS[r.id](`${head}0`));
    const full = r.find(() => `A0${r.string(17, HEX)}`, (head) => CHECKSUMS[r.id](`${head}F`));
    r.add(`${zero}0`, `${zero}F`, `${full}F`, `${full}0`);
    // Lower-case hexadecimal is not normalized here, and a check past F is no hexadecimal digit.
    r.add(valid[0]!.toLowerCase(), `${valid[0]!.slice(0, 19)}G`);
  },

  'poczta-polska'(r) {
    // The checksum is a GS1 key over twenty digits; the 5900773 prefix belongs to the detection pattern.
    const own = () => r.complete(`00${r.pick(DIGITS)}5900773${r.string(9)}`);
    const valid = [own(), own(), own(), own(), r.complete(`590${r.string(16)}`), r.complete(`00${r.string(17)}`), r.complete(r.string(19)), r.complete(r.string(19))];
    standard(r, valid);
    r.add(completeBy(hasGs1CheckDigit, r.string(18)), completeBy(hasGs1CheckDigit, r.string(20)));
  },

  'poste-italiane'(r) {
    // Eleven digits and the check digit; the barcode specification's own examples.
    const valid = Array.from({ length: 8 }, () => r.complete(r.string(11)));
    standard(r, valid);
    r.add('123456789012', '610000000019', '100050045011');
    // A digit in an even place weighs eleven, one in an odd place one: a swapped pair changes the check.
    const first = valid.find((value) => value[0] !== value[1])!;
    r.add(`${first[1]}${first[0]}${first.slice(2)}`);
    // The check is the digit sum of the total, not the total itself, mod 10.
    const total = (digits: string) => [...digits].reduce((sum, digit, index) => sum + Number(digit) * (index % 2 ? 11 : 1), 0);
    const digitSum = (value: number) => [...String(value)].reduce((sum, digit) => sum + Number(digit), 0);
    const carried = r.find(() => r.string(11), (digits) => total(digits) % 10 !== digitSum(total(digits)) % 10);
    r.add(`${carried}${total(carried) % 10}`, r.complete(carried));
    r.add(r.complete('00000000000'), r.complete('99999999999'), r.complete('09090909090'));
  },

  'pos-laju'(r) {
    // Three letters, nine digits whose last is the S10 check digit, then MY.
    const valid = ['EHE', 'ERA', 'ENE', 'ERD', 'ENB', 'ERB', 'REL', 'XYZ'].map((letters) => r.complete(letters + r.string(8), 'MY'));
    standard(r, valid, 11);
    // 11 minus the sum mod 11: 10 becomes 0 and 11 becomes 5.
    const ten = r.find(() => r.string(8), (serial) => weightedSum(serial, S10_WEIGHTS) % 11 === 1);
    const eleven = r.find(() => r.string(8), (serial) => weightedSum(serial, S10_WEIGHTS) % 11 === 0);
    r.add(`EHE${ten}0MY`, `EHE${ten}1MY`, `EHE${eleven}5MY`, `EHE${eleven}0MY`, `EHE${eleven}1MY`);
    // Three letters before the digits and MY after them; the letters are outside the check.
    const first = valid[0]!;
    r.add(`ZZZ${first.slice(3)}`, first.slice(1), `E${first}`, `EH1${first.slice(3)}`);
    r.add(`${first.slice(0, 12)}MX`, `${first.slice(0, 12)}SG`, `${first.slice(0, 12)}M`, `${first}Y`);
    // The check takes a normalized number, as detection passes it.
    r.add(`${first.slice(0, 3)} ${first.slice(3, 12)} MY`);
    r.add('AAA000000005MY', 'ZZZ999999995MY');
  },

  s10(r) {
    // Service letters, then the issuing country.
    const valid = ['RR CN', 'LX FR', 'CP GB', 'EE US', 'UA CH', 'LZ DE', 'RA NL', 'CY SE', 'LP JP', 'EA BR', 'XU ES', 'VV YP']
      .map((ends) => r.complete(ends.slice(0, 2) + r.string(8), ends.slice(3)));
    standard(r, valid, 10);
    // 11 minus the sum mod 11: 10 becomes 0 and 11 becomes 5.
    const ten = r.find(() => r.string(8), (serial) => weightedSum(serial, S10_WEIGHTS) % 11 === 1);
    const eleven = r.find(() => r.string(8), (serial) => weightedSum(serial, S10_WEIGHTS) % 11 === 0);
    r.add(`RR${ten}0CH`, `RR${ten}1CH`, `RR${eleven}5CH`, `RR${eleven}0CH`, `RR${eleven}1CH`);
    r.add('AA000000005AA', 'AA000000000AA', 'ZZ999999995ZZ');
    // Two letters on each side.
    const first = valid[0]!;
    r.add(`R1${first.slice(2)}`, `${first.slice(0, 11)}C1`, `${first.slice(0, 11)}C`, `${first}H`, `R${first}`);
    // The validator normalizes its input itself.
    r.add(`${first.slice(0, 2)}.${first.slice(2, 5)}.${first.slice(5, 8)}.${first.slice(8, 11)}-${first.slice(11)}`);
  },

  saia(r) {
    // Ten digits, a 0, then the remainder of the ten divided by seven.
    const valid = Array.from({ length: 8 }, () => r.complete(`${r.string(10)}0`));
    standard(r, valid);
    const first = valid[0]!;
    const ten = first.slice(0, 10);
    // A remainder is never 7, 8 or 9, and any other eleventh digit is not checked.
    r.add(`${ten}07`, `${ten}08`, `${ten}09`);
    for (const digit of ['1', '5', '9']) r.add(`${ten}${digit}${first[11]}`, ...r.completions(`${ten}${digit}`).map((last) => `${ten}${digit}${last}`));
    // The eleven digits before the check, divided by seven, do not close it.
    const whole = r.find(() => r.string(10), (digits) => Number(`${digits}0`) % 7 !== Number(digits) % 7);
    r.add(`${whole}0${Number(`${whole}0`) % 7}`, `${whole}0${Number(whole) % 7}`);
    r.add(r.complete('00000000000'), r.complete('99999999990'), r.complete('00000000070'));
  },

  'sf-express'(r) {
    const valid = [
      ...Array.from({ length: 6 }, () => r.complete(r.string(11))),
      ...Array.from({ length: 4 }, () => r.complete(`SF${r.string(12)}`)),
    ];
    standard(r, valid);
    // The three-digit area code is outside the check.
    const first = valid[0]!;
    r.add(`${r.string(3)}${first.slice(3)}`, `000${first.slice(3)}`);
    // SF and thirteen digits, or twelve digits.
    const sf = valid[6]!;
    r.add(sf.slice(2), `SF${first}`, `SG${sf.slice(2)}`, `FS${sf.slice(2)}`, `S${sf.slice(2)}`, sf.toLowerCase());
    r.add(r.complete('0'.repeat(11)), r.complete('9'.repeat(11)), r.complete(`SF${'9'.repeat(12)}`));
  },

  sscc(r) {
    const valid = [
      ...Array.from({ length: 5 }, () => r.complete(`00${r.string(17)}`)),
      r.complete(`0034043${r.pick('345')}${r.string(11)}`),
      r.complete(`0034043${r.pick('345')}${r.string(11)}`),
    ];
    standard(r, valid);
    // A valid GS1 key needs the 00 application identifier in front of eighteen digits.
    const gs1 = (head: string) => completeBy(hasGs1CheckDigit, head);
    const serial = r.string(17);
    r.add(gs1(serial), gs1(`01${serial}`), gs1(`90${serial}`), gs1(`000${serial}`), gs1(`0${serial}`));
    r.add(r.complete(`00${'9'.repeat(17)}`), `(00)${valid[0]!.slice(2)}`);
  },

  tnt(r) {
    // Mod 7 and Mod 11 mostly disagree: keep both answers for the same eight digits.
    const valid: string[] = [];
    for (let index = 0; index < 3; index++) {
      const head = r.find(() => r.string(8), (digits) => r.completions(digits).length === 2);
      valid.push(...r.completions(head).map((digit) => head + digit));
    }
    valid.push(r.complete(r.string(8)), r.complete(r.string(8)));
    standard(r, valid);
    // Mod 11 turns 11 into 5 and 10 into 0.
    const mod7 = (digits: string) => Number(digits) % 7;
    const eleven = r.find(() => r.string(8), (digits) => weightedSum(digits, S10_WEIGHTS) % 11 === 0 && ![0, 1, 5].includes(mod7(digits)));
    const ten = r.find(() => r.string(8), (digits) => weightedSum(digits, S10_WEIGHTS) % 11 === 1 && ![0, 1].includes(mod7(digits)));
    r.add(`${eleven}5`, `${eleven}0`, `${eleven}1`, `${ten}0`, `${ten}1`);
    const head = valid[0]!.slice(0, -1);
    r.add(head + [...DIGITS].find((digit) => !r.completions(head).includes(digit))!);
    r.add('000000005');
  },

  ukrposhta(r) {
    const valid = Array.from({ length: 8 }, () => r.complete(r.string(12)));
    standard(r, valid);
    // A remainder of 10 or 11 gives 0; writing 11 as 1 fails.
    for (const remainder of [0, 1]) {
      const head = r.find(() => r.string(12), (digits) => mod11Sum(digits) % 11 === remainder);
      r.add(`${head}0`, `${head}1`);
    }
    r.add(r.complete('0'.repeat(12)), r.complete('9'.repeat(12)));
  },

  ups(r) {
    const valid = [
      ...Array.from({ length: 6 }, () => r.complete(`1Z${r.string(6, ALNUM)}${r.string(9)}`)),
      r.complete('1ZABCDEFGHIJKLMNO'),
      r.complete(`1ZPQRSTUVWXYZ${r.string(4)}`),
    ];
    standard(r, valid);
    // A letter counts its ASCII code minus 63, mod 10: A and K are 2, I and S are 0, Z is 7.
    const alphabet = valid[6]!;
    r.add(replaceAt(alphabet, 2, '2'), replaceAt(alphabet, 2, 'K'), replaceAt(alphabet, 2, 'B'), replaceAt(alphabet, 10, '0'), replaceAt(alphabet, 10, 'S'));
    r.add(replaceAt(valid[7]!, 12, '7'), replaceAt(valid[7]!, 12, 'Y'));
    // 1Z opens the number and a digit closes it.
    const first = valid[0]!;
    r.add(`IZ${first.slice(2)}`, `1Y${first.slice(2)}`, `${first.slice(0, -1)}Z`);
    r.add(r.complete(`1Z${'0'.repeat(15)}`), r.complete(`1Z${'9'.repeat(15)}`), r.complete(`1Z${'Z'.repeat(15)}`));
  },

  usps(r) {
    const pic = (channel: string, length: number) => r.complete(`9${channel}${r.string(length - 3)}`);
    // Channels 91 to 95 at 22 digits, 92 to 94 at 26.
    const valid = [pic('4', 22), pic('1', 22), pic('2', 22), pic('3', 22), pic('5', 22), pic('2', 26), pic('3', 26), pic('4', 26)];
    // Routing AI 420 with a ZIP5 or ZIP9 before the PIC.
    const routed = (zipLength: number, channel: string, picLength: number) =>
      r.find(() => `420${r.string(zipLength)}${pic(channel, picLength)}`, CHECKSUMS.usps);
    valid.push(routed(5, '5', 22), routed(9, '2', 22), routed(5, '3', 26));
    standard(r, valid);
    // 91 and 95 are read only at 22 digits; 90 and 96 not at all.
    const mod10 = (head: string) => completeBy(hasGs1CheckDigit, head);
    r.add(mod10(`91${r.string(23)}`), mod10(`95${r.string(23)}`), mod10(`90${r.string(19)}`), mod10(`96${r.string(19)}`));
    // A 34-digit scan fits ZIP5 with a 26-digit PIC or ZIP9 with a 22-digit
    // one. When both readings pass the check digit, the one whose Mailer ID
    // fits its channel is kept, and with none or both the scan is rejected. A
    // ZIP+4 starting 92 here gives the 26-digit reading a Mailer ID without
    // its leading 9; one starting 91 or 95 never makes that reading valid.
    const inner = pic('4', 22);
    for (const channel of ['91', '95', '92', '93', '94']) {
      const plus4 = completeBy((value) => hasGs1CheckDigit(value + inner), channel + r.string(1));
      r.add(`420${r.string(5)}${plus4}${inner}`);
    }
    r.add(`421${valid.at(-3)!.slice(3)}`, `420${r.string(9)}${r.string(18)}`, `${valid.at(-3)!}0`);
    // The other way round: the last 22 digits of this channel 93 PIC also pass
    // the check digit, as a channel 92 PIC whose Mailer ID starts with 0, which
    // does not fit, or 9, which does.
    for (const mailerId of ['0', '9']) r.add(`420${r.string(5)}${r.complete(`930092${r.string(3)}${mailerId}${r.string(15)}`)}`);
    // A ZIP+4 before a 26-digit PIC has a single reading.
    const routed38 = `420${r.string(9)}${pic('3', 26)}`;
    r.add(routed38, `${routed38.slice(0, -1)}${(Number(routed38.at(-1)) + 5) % 10}`);
  },
};

/** One list per checksum id, ids sorted, each in the order its recipe adds them. */
export function buildChecksumVectors(): ChecksumVectors {
  const ids = (Object.keys(CHECKSUMS) as ChecksumId[]).sort();
  const vectors = Object.fromEntries(ids.map((id) => {
    const recipe = new Recipe(id);
    RECIPES[id](recipe);
    return [id, recipe.vectors()];
  })) as Record<ChecksumId, ChecksumVector[]>;
  return { version: 1, vectors };
}

/** Printable ASCII only, so the bytes survive any editor. */
const json = (value: string) => JSON.stringify(value)
  .replace(/[^ -~]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);

/** One vector per line, so a change reads as a diff of the inputs it affects. */
export function serializeChecksumVectors(file: ChecksumVectors): string {
  const lists = (Object.entries(file.vectors) as [ChecksumId, readonly ChecksumVector[]][]).map(([id, vectors]) => {
    const rows = vectors.map(([input, valid]) => `      [${json(input)}, ${valid}]`);
    return `    ${json(id)}: [\n${rows.join(',\n')}\n    ]`;
  });
  return `{\n  "version": ${file.version},\n  "vectors": {\n${lists.join(',\n')}\n  }\n}\n`;
}

export function readChecksumVectorsText(): string {
  return readFileSync(VECTORS_PATH, 'utf8');
}

export function writeChecksumVectors(): ChecksumVectors {
  const file = buildChecksumVectors();
  writeFileSync(VECTORS_PATH, serializeChecksumVectors(file));
  return file;
}
