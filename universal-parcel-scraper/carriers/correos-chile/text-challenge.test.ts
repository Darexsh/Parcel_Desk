import { expect, it, vi } from 'vitest';
import { solveCorreosChileText } from './text-challenge.js';
import { answerCorreosChileText } from './text-model.js';

it('answers exact arithmetic and string operations without guessing unfamiliar instructions', () => {
  expect(solveCorreosChileText('Find the number of coins still in the jar. Use digits only', 'A jar contains 19 coins. You remove 6 coins from it.')).toBe('13');
  expect(solveCorreosChileText('How many did you remove?', 'A jar contains 19 coins. You remove 6 coins from it.')).toBeNull();
  expect(solveCorreosChileText('Give the final coin count in the jar using digits only', 'A jar starts with 4 coins. You take 8 coins out.')).toBeNull();
  expect(solveCorreosChileText('Work out how many coins remain in the jar. Use digits only', 'A jar contains 23 coins. You remove 1 coin from it')).toBe('22');
  expect(solveCorreosChileText('Calculate the coins remaining in the jar. Answer with digits only', 'A jar contains 32 coins. You remove 14 coins from it')).toBe('18');
  expect(solveCorreosChileText('After the removal how many coins remain. Answer with digits only', 'A jar starts with 21 coins. You take 20 coins out.')).toBe('1');
  expect(solveCorreosChileText('Follow the instructions', 'Duplicate every r in carrot. Write only the result.')).toBe('carrrrot');
  expect(solveCorreosChileText('Count letters', 'How many letters e does evergreen contain? Answer using digits.')).toBe('4');
  expect(solveCorreosChileText('Write the result', 'Use the Latin z instead of every a in banana. Type just the result.')).toBe('bznznz');
  expect(solveCorreosChileText('Count letters', 'Find the number of letters n in banana. Answer using digits.')).toBe('2');
  expect(solveCorreosChileText('Respond with just the result.', 'Replace every t with the Latin x in tablet. Write only the result.')).toBe('xablex');
  expect(solveCorreosChileText('Give just the result.', 'Change each t to the Latin x in tablet. Type just the result.')).toBe('xablex');
  expect(solveCorreosChileText('Enter only the answer.', 'Delete every 4 from 84604. Keep leading zeros and type only the remaining digits.')).toBe('860');
  expect(solveCorreosChileText('Enter only the answer.', 'Delete every 1 from 10213. Write the remaining digits, keeping leading zeros.')).toBe('023');
  expect(solveCorreosChileText('Write just your answer.', 'Remove each 5 from 50551. Write the remaining digits, keeping leading zeros.')).toBe('01');
  expect(solveCorreosChileText('Give just the result.', 'Take out each 2 from 32123. Write the remaining digits, keeping leading zeros.')).toBe('313');
  expect(solveCorreosChileText('Enter only the answer.', 'Delete every 7 from 777. Write the remaining digits, keeping leading zeros.')).toBeNull();
  expect(solveCorreosChileText('Pick one', 'unknown question')).toBeNull();
  expect(solveCorreosChileText('x'.repeat(151), 'question')).toBeNull();
});

it('sends only bounded questions through the supplied transport and accepts short answers', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ choices: [{ message: { content: '  apple. ' } }] }));
  const signal = new AbortController().signal;
  await expect(answerCorreosChileText('http://model.test/v1/chat/completions', 'Select a fruit', 'apple chair clock', signal, 500, fetcher)).resolves.toBe('apple');
  const body = JSON.parse(String(fetcher.mock.calls[0]![1]?.body));
  expect(body).toMatchObject({ messages: expect.arrayContaining([{ role: 'system', content: expect.any(String) }]), max_tokens: 32, temperature: 0, stream: false });
  expect(body.messages.at(-1)).toEqual({ role: 'user', content: 'Select a fruit\napple chair clock' });
  await expect(answerCorreosChileText('http://model.test', 'x'.repeat(151), 'q', signal, 500, fetcher)).resolves.toBeNull();
  expect(fetcher).toHaveBeenCalledOnce();
});

// Recorded question shapes with synthetic words.
it('asks once more with the choices when the model answers a word the question does not list', async () => {
  const replies = (...contents: string[]) => {
    const fetcher = vi.fn<typeof fetch>();
    for (const content of contents) fetcher.mockResolvedValueOnce(Response.json({ choices: [{ message: { content } }] }));
    return fetcher;
  };
  const signal = new AbortController().signal, url = 'http://model.test';
  const fetcher = replies('shirt', 'Jacket');
  await expect(answerCorreosChileText(url, 'Write the clothing word from these three words', 'apple jacket tree', signal, 500, fetcher)).resolves.toBe('jacket');
  expect(JSON.parse(String(fetcher.mock.calls[1]![1]?.body)).messages.slice(-2)).toEqual([{ role: 'assistant', content: 'shirt' },
    { role: 'user', content: 'Answer with exactly one of: apple, jacket, tree.' }]);
  await expect(answerCorreosChileText(url, 'Name the object made to produce light when lit or switched on in this list.', 'plate, lightbulb, chair',
    signal, 500, replies('lamp', 'lantern'))).resolves.toBeNull();
  const listed = replies('cap');
  await expect(answerCorreosChileText(url, 'Type only the clothing word from these three words', 'cup clock cap', signal, 500, listed)).resolves.toBe('cap');
  const open = replies('door');
  await expect(answerCorreosChileText(url, 'Answer the following question with a single word, number, or phrase.', 'What opens and closes to enter a room?',
    signal, 500, open)).resolves.toBe('door');
  expect([listed, open].map(f => f.mock.calls.length)).toEqual([1, 1]);
});

it('asks about each listed word on its own for the one that is not of a kind', async () => {
  const replies = (...contents: string[]) => {
    const fetcher = vi.fn<typeof fetch>();
    for (const content of contents) fetcher.mockResolvedValueOnce(Response.json({ choices: [{ message: { content } }] }));
    return fetcher;
  };
  const signal = new AbortController().signal, url = 'http://model.test';
  const asked = (fetcher: ReturnType<typeof replies>) => fetcher.mock.calls.map(call => JSON.parse(String(call[1]?.body)).messages.at(-1).content);
  const clothing = replies('no', 'Yes.', 'yes, boots are worn');
  await expect(answerCorreosChileText(url, 'Write the item that is not clothing from these three words', 'pencil vest boots', signal, 500, clothing)).resolves.toBe('pencil');
  expect(asked(clothing)).toEqual(["Is the word 'pencil' clothing?", "Is the word 'vest' clothing?", "Is the word 'boots' clothing?"]);
  expect(JSON.parse(String(clothing.mock.calls[0]![1]?.body)).max_tokens).toBe(4);
  const piece = replies('yes', 'no', 'yes');
  await expect(answerCorreosChileText(url, 'Identify the word that does not name a piece of clothing', 'socks ladder jacket', signal, 500, piece)).resolves.toBe('ladder');
  expect(asked(piece)[1]).toBe("Is the word 'ladder' a piece of clothing?");
  const animal = replies('yes', 'yes', 'no');
  await expect(answerCorreosChileText(url, 'Which item is not an animal. Write its name', 'whale goat toaster', signal, 500, animal)).resolves.toBe('toaster');
  expect(asked(animal)[2]).toBe("Is the word 'toaster' an animal?");
  // Two words outside the kind, or an unclear reply, leave the question to the whole prompt.
  const unsure = replies('no', 'no', 'maybe', 'clock');
  await expect(answerCorreosChileText(url, 'Which item is not clothing Write its name', 'clock raincoat shorts', signal, 500, unsure)).resolves.toBe('clock');
  expect(unsure).toHaveBeenCalledTimes(4);
});

it('asks whether a thing floats rather than whether it sinks or floats', async () => {
  const signal = new AbortController().signal, question = 'Will an inflated beach ball sink or float when released in fresh water?';
  const ask = (content: string) => vi.fn<typeof fetch>().mockResolvedValue(Response.json({ choices: [{ message: { content } }] }));
  const yes = ask('Yes.');
  await expect(answerCorreosChileText('http://model.test', 'Respond with the matching property from the question.', question, signal, 500, yes)).resolves.toBe('float');
  expect(JSON.parse(String(yes.mock.calls[0]![1]?.body)).messages.at(-1)).toEqual({ role: 'user', content: 'Does an inflated beach ball float on fresh water?' });
  await expect(answerCorreosChileText('http://model.test', 'Respond with the matching property from the question.', question, signal, 500, ask('no'))).resolves.toBe('sink');
  await expect(answerCorreosChileText('http://model.test', 'Respond with the matching property from the question.', question, signal, 500, ask('it floats'))).resolves.toBeNull();
});

it('strips model diagnostics while preserving rate limits and cancellation', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('PRIVATE response', { status: 429, headers: { 'retry-after': '30' } }));
  const controller = new AbortController();
  const result = answerCorreosChileText('http://model.test/PRIVATE', 'Question', 'PRIVATE prompt', controller.signal, 500, fetcher);
  await expect(result).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 30_000 });
  const error = await result.catch(e => e);
  expect(JSON.stringify(error)).not.toContain('PRIVATE');
  expect(error.cause).toBeUndefined();
  controller.abort(new Error('cancelled'));
  await expect(answerCorreosChileText('http://model.test', 'Question', 'q', controller.signal, 500, fetcher)).rejects.toBe(controller.signal.reason);
});

it.each(['<script>bad</script>', 'x'.repeat(61), 'a\nb', ''])('refuses unbounded or non-answer model output', async content => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ choices: [{ message: { content } }] }));
  await expect(answerCorreosChileText('http://model.test', 'Question', 'q', new AbortController().signal, 500, fetcher)).resolves.toBeNull();
});

it('does not mistake a missing model route for a missing shipment', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('missing', { status: 404 }));
  await expect(answerCorreosChileText('http://model.test', 'Question', 'q', new AbortController().signal, 500, fetcher)).rejects.toMatchObject({ kind: 'transport' });
});
