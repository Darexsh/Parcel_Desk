import { isValidS10TrackingNumber, normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { calendarDay } from '../../core/time/index.js';
import { textFromHtml } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { classifyHongkongPostStatus } from './status.js';

export const PROVIDER = 'Hongkong Post';
/** Menus and answers are under 2 kB; anything far larger is not a bot message. */
const MAX_MESSAGE_LENGTH = 20_000;

export function normalizeHongkongPostNumber(raw: string): string {
  if (raw.length > 64) throw new InvalidInputError(PROVIDER, 'Hongkong Post tracking number is too long');
  const number = normalizeTrackingNumber(raw);
  if (!/^[A-Z]{2}\d{9}HK$/.test(number) || !isValidS10TrackingNumber(number)) {
    throw new InvalidInputError(PROVIDER, 'Hongkong Post requires a checksum-valid postal item number ending in HK');
  }
  return number;
}

/**
 * The scripted way from the language menu to Mail Tracing, in order. Each
 * reply must list the option the next input picks, so a reworded or reordered
 * menu fails as a changed reply instead of sending a digit somewhere else.
 */
export const MAIL_TRACING_PATH = [
  { option: '2', label: '英文 / English' },
  { option: '3', label: 'Mail Tracing and Compensation' },
  { option: '1', label: 'Mail Tracing' },
] as const;

export type MenuOption = (typeof MAIL_TRACING_PATH)[number];

/** The visible lines of a bot message: `<br>` breaks a line, other markup is dropped. */
function lines(text: string): string[] {
  return text.split(/<br\s*\/?>/i).map(line => textFromHtml(line, 1_000)).filter(Boolean);
}

/**
 * The text of one long-poll reply, null when the poll found no message yet, or
 * why it carries none.
 */
export function pollMessage(payload: unknown): string | null {
  if (!isRecord(payload)) throw new SchemaError(PROVIDER, 'Hongkong Post chatbot returned an invalid reply');
  if (payload.Status === 'SessionEnd') throw new IndeterminateError(PROVIDER, 'Hongkong Post chatbot ended the session');
  // A conversation handed to a person is no longer the scripted menu.
  if (payload.live_chat === true) throw new IndeterminateError(PROVIDER, 'Hongkong Post chatbot handed the session to live chat');
  if (payload.Success === false) {
    // The official client polls again after any reply without `Success: true`, as after an idle 408.
    if (payload.message === undefined || payload.message === null) return null;
    throw new IndeterminateError(PROVIDER, 'Hongkong Post chatbot reported a failed reply');
  }
  if (payload.Success !== true) throw new SchemaError(PROVIDER, 'Hongkong Post chatbot returned an invalid reply');
  const message = payload.message;
  if (!isRecord(message) || typeof message.text !== 'string' || !message.text.trim() || message.text.length > MAX_MESSAGE_LENGTH) {
    throw new SchemaError(PROVIDER, 'Hongkong Post chatbot returned an invalid message');
  }
  return message.text;
}

/** Whether the chatbot accepted one input. */
export function sendAccepted(payload: unknown): void {
  if (isRecord(payload) && isRecord(payload.data) && payload.data.Success === true) return;
  if (isRecord(payload) && isRecord(payload.data) && payload.data.Success === false) {
    throw new IndeterminateError(PROVIDER, 'Hongkong Post chatbot did not accept the message');
  }
  throw new SchemaError(PROVIDER, 'Hongkong Post chatbot returned an invalid acknowledgement');
}

/** The menu must offer `option` under its expected label, once. */
export function expectMenuOption(text: string, { option, label }: MenuOption): void {
  const offered = lines(text).flatMap(line => {
    const match = /^(\d{1,2})\.\s*(.+)$/.exec(line);
    return match?.[1] === option ? [match[2]!] : [];
  });
  if (offered.length !== 1 || offered[0] !== label) throw new SchemaError(PROVIDER, 'Hongkong Post chatbot menu changed');
}

/** The Mail Tracing prompt is the only reply after which the number is sent. */
export function expectNumberPrompt(text: string): void {
  const [title, prompt] = lines(text);
  if (title !== 'Mail Tracing' || !prompt?.startsWith('Please enter the tracking number')) {
    throw new SchemaError(PROVIDER, 'Hongkong Post chatbot did not ask for a tracking number');
  }
}

const FOUND = /^According to the system record, status of the mail item (?:at as|as at) (\d{2})-(\d{2})-(\d{4}) (\d{2}):(\d{2}) is as follows: (.+)$/;

/**
 * The answer to the number. It does not repeat the number: the caller binds it
 * by sending the number once, last, in a session of its own. Only the first
 * line is read; the rest are contact and menu links.
 */
export function parseHongkongPostAnswer(text: string): CarrierResult {
  const first = text.split(/<br\s*\/?>/i, 1)[0] ?? '';
  const line = textFromHtml(first, 1_000);
  if (/[<>]/.test(first) || !line) throw new SchemaError(PROVIDER, 'Hongkong Post chatbot returned an unexpected answer');
  if (line.startsWith('The system has no record of the mail item enquired')) throw new NotFoundError(PROVIDER);
  if (line.startsWith('Invalid Mail Number!')) throw new InvalidInputError(PROVIDER, 'Hongkong Post rejected the tracking number', { reason: 'wrong_number' });
  if (line.startsWith('Sorry, the information entered is incorrect')) throw new SchemaError(PROVIDER, 'Hongkong Post chatbot menu changed');
  const match = FOUND.exec(line);
  if (!match) throw new SchemaError(PROVIDER, 'Hongkong Post chatbot returned an unexpected answer');
  const [, day, month, year, hour, minute, rawStatus] = match;
  const date = calendarDay(Number(year), Number(month), Number(day));
  if (!date || Number(hour) > 23 || Number(minute) > 59) throw new SchemaError(PROVIDER, 'Hongkong Post chatbot returned an invalid status time');
  const wording = rawStatus!.trim().replace(/\.$/, '').trim();
  if (!wording || wording.length > 200) throw new SchemaError(PROVIDER, 'Hongkong Post chatbot returned an invalid status');
  const classified = classifyHongkongPostStatus(wording);
  // The clock is the latest event's, in local time where it happened, which
  // for an outward item is the destination. The answer names no place.
  return {
    status: classified.status, ...(classified.stage ? { current_stage: classified.stage, current_stage_source: classified.source } : {}),
    last_status_text: wording, last_update: null, last_update_local: `${date}T${hour}:${minute}:00`,
    expected_delivery: null, summary_only: true, events: [],
  };
}
