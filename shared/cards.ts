/*
 * Transcript cards: what a Boton may show its owner in the chat, as data. A card is a fixed list of known blocks
 * (text, status, progress, a table, a workspace file, a link) and at most one thing to answer (a choice, a form, or
 * a connector to give it). There is no markup, script, style or callback in it: the web app draws each block itself,
 * every string as plain text, and what an answer does is decided by the server from the card it saved, never from
 * what the client or the Boton sends with it.
 *
 * This file is the protocol and its checks, shared by the server (which refuses anything else) and the web app.
 * It imports nothing.
 */

export const CARD_VERSION = 1;

export const CARD_LIMITS = {
  /** The card as saved, in characters of JSON. */
  bytes: 16_000,
  title: 120,
  blocks: 20,
  text: 2000,
  status: 300,
  label: 120,
  columns: 8,
  rows: 50,
  cell: 200,
  options: 8,
  optionLabel: 80,
  fields: 8,
  fieldLabel: 80,
  selectOptions: 20,
  placeholder: 80,
  valueMax: 2000,
  url: 2000,
  path: 500,
  submit: 40,
} as const;

export type CardTone = 'info' | 'success' | 'warning' | 'error' | 'working';
export type CardCell = string | number | null;
export interface CardOption {
  id: string;
  label: string;
}

export type CardFieldKind = 'text' | 'textarea' | 'number' | 'select' | 'checkbox';
export interface CardField {
  id: string;
  label: string;
  kind: CardFieldKind;
  required?: boolean;
  /** text and textarea: at most this many characters (default and max CARD_LIMITS.valueMax). */
  maxLength?: number;
  /** number only. */
  min?: number;
  max?: number;
  /** select only. */
  options?: CardOption[];
  placeholder?: string;
}

export type CardBlock =
  | { type: 'text'; text: string }
  | { type: 'status'; tone: CardTone; text: string }
  | { type: 'progress'; label: string; value: number; max: number }
  | { type: 'table'; columns: string[]; rows: CardCell[][] }
  /** A file in the Boton's workspace, opened in the app's own file viewer. `path` is checked by the server when posted. */
  | { type: 'file'; path: string; title?: string }
  /** An https link, shown with its host; never a script, data or local address. */
  | { type: 'link'; url: string; label: string }
  | { type: 'choice'; id: string; prompt: string; options: CardOption[] }
  | { type: 'form'; id: string; prompt?: string; fields: CardField[]; submit?: string }
  /** Asks the owner to give the Boton this connector: what that does, and the button, are the server's. */
  | { type: 'connector'; connectorId: string };

export type InteractiveBlock = Extract<CardBlock, { type: 'choice' | 'form' | 'connector' }>;

/** What a Boton posts (`botons card post`). */
export interface CardDescriptor {
  v: typeof CARD_VERSION;
  title: string;
  blocks: CardBlock[];
}

/** shown: nothing to answer. refused: the server could not do what the answer asked (see `reason`), so nothing was done. */
export type CardStatus = 'shown' | 'pending' | 'answered' | 'declined' | 'expired' | 'refused';

/** What the owner sends to answer a card. */
export type CardAnswerInput =
  | { action: 'choose'; option: string }
  | { action: 'submit'; values: Record<string, string | number | boolean> }
  | { action: 'grant' }
  | { action: 'decline' };

/** How a card was answered, as the server recorded it. */
export interface CardAnswer {
  action: CardAnswerInput['action'];
  at: string;
  /** The device that answered. */
  by: string | null;
  /** choose: the option chosen. */
  option?: CardOption;
  /** submit: the values, by field id, as checked. */
  values?: Record<string, string | number | boolean>;
  /** grant: the connector was added, or the Boton had it already. */
  result?: 'granted' | 'already';
}

/** A posted card, as the server keeps it (Message.meta.card of a card.posted event). */
export interface TranscriptCard {
  descriptor: CardDescriptor;
  status: CardStatus;
  expiresAt: string;
  /** Where it was posted from, as the server knew it (never what the Boton said). */
  from: { trigger: string; routineId: string | null; routineName: string | null; runId: string | null; sandboxed: boolean };
  /** A connector block: its name and the request policy generation the card was posted under. */
  connector?: { id: string; name: string; generation: number };
  answer?: CardAnswer;
  /** refused: why the server refused the answer and closed the card. */
  reason?: string;
}

export class CardError extends Error {}

const ID = /^[a-z][a-z0-9_-]{0,31}$/;
export const CONNECTOR_ID = /^[a-z]+:[a-z0-9][a-z0-9_-]{0,63}$/;
const BANNED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
/**
 * Field wording that asks for a secret. Cards never take passwords, keys, tokens or codes: an answer goes into the
 * transcript and to the Boton. Signing in to a service goes through Settings, and typing into a site through the
 * owner's own browser handover.
 */
const SECRET_WORDS =
  /pass\s*(word|phrase|code)|\bpwd\b|secret|token|api[\s_-]*key|access[\s_-]*key|private[\s_-]*key|credential|\bpin\b|\botp\b|\b2fa\b|\bmfa\b|one[\s_-]*time|verification[\s_-]*code|security[\s_-]*code|recovery[\s_-]*code|\bssn\b|social[\s_-]*security|card[\s_-]*number|\bcvv\b|\bcvc\b|\biban\b|seed[\s_-]*phrase|mnemonic|cookie|session[\s_-]*id|bearer/i;

const fail = (msg: string): never => {
  throw new CardError(msg);
};

/** A plain JSON object with exactly the allowed keys (no prototype tricks), `required` ones present. */
function object(v: unknown, where: string, allowed: readonly string[], required: readonly string[] = []): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) fail(`${where} must be an object`);
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) fail(`${where} must be a plain object`);
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    if (BANNED_KEYS.has(k)) fail(`${where} has a key that is not allowed: ${k}`);
    if (!allowed.includes(k)) fail(`${where} has an unknown field "${k}" (allowed: ${allowed.join(', ')})`);
  }
  for (const k of required) if (o[k] === undefined) fail(`${where}.${k} is required`);
  return o;
}

/** Control characters out (newlines kept only where `multiline`), trimmed, bounded. */
export function cleanText(v: unknown, where: string, max: number, opts: { multiline?: boolean; required?: boolean } = {}): string {
  if (typeof v !== 'string') return fail(`${where} must be a string`);
  let t = v.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, '');
  t = opts.multiline ? t.replace(/\t/g, '  ').replace(/\n{3,}/g, '\n\n').trim() : t.replace(/\s+/g, ' ').trim();
  if (opts.required !== false && !t) fail(`${where} must not be empty`);
  if (t.length > max) fail(`${where} is too long (max ${max} characters)`);
  return t;
}

function int(v: unknown, where: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fail(`${where} must be a number`);
  if (v < min || v > max) fail(`${where} must be between ${min} and ${max}`);
  return v;
}

function list(v: unknown, where: string, min: number, max: number): unknown[] {
  if (!Array.isArray(v)) return fail(`${where} must be a list`);
  if (v.length < min || v.length > max) fail(min === max ? `${where} must have ${min} items` : `${where} must have ${min} to ${max} items`);
  return v;
}

function id(v: unknown, where: string): string {
  if (typeof v !== 'string' || !ID.test(v) || BANNED_KEYS.has(v)) fail(`${where} must be a short id: lowercase letters, digits, - and _, starting with a letter`);
  return v as string;
}

function options(v: unknown, where: string, min: number, max: number): CardOption[] {
  const seen = new Set<string>();
  return list(v, where, min, max).map((x, i) => {
    const o = object(x, `${where}[${i}]`, ['id', 'label'], ['id', 'label']);
    const oid = id(o.id, `${where}[${i}].id`);
    if (seen.has(oid)) fail(`${where} has the id "${oid}" twice`);
    seen.add(oid);
    return { id: oid, label: cleanText(o.label, `${where}[${i}].label`, CARD_LIMITS.optionLabel) };
  });
}

/** An absolute https URL with a host, no user name or password in it, or a reason it isn't one. */
export function safeLinkProblem(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return 'is not a valid URL';
  }
  if (u.protocol !== 'https:') return 'must be an https:// link';
  if (u.username || u.password) return 'must not have a user name or password in it';
  if (!u.hostname || !u.hostname.includes('.')) return 'must name a site';
  return null;
}

function secretWording(...texts: (string | undefined)[]): boolean {
  return texts.some((t) => !!t && SECRET_WORDS.test(t));
}

function field(v: unknown, where: string): CardField {
  const o = object(v, where, ['id', 'label', 'kind', 'required', 'maxLength', 'min', 'max', 'options', 'placeholder'], ['id', 'label', 'kind']);
  const f: CardField = { id: id(o.id, `${where}.id`), label: cleanText(o.label, `${where}.label`, CARD_LIMITS.fieldLabel), kind: 'text' };
  const kinds: CardFieldKind[] = ['text', 'textarea', 'number', 'select', 'checkbox'];
  if (!kinds.includes(o.kind as CardFieldKind)) fail(`${where}.kind must be one of ${kinds.join(', ')}`);
  f.kind = o.kind as CardFieldKind;
  if (o.required !== undefined) {
    if (typeof o.required !== 'boolean') fail(`${where}.required must be true or false`);
    if (o.required) f.required = true;
  }
  if (o.placeholder !== undefined) f.placeholder = cleanText(o.placeholder, `${where}.placeholder`, CARD_LIMITS.placeholder);
  const only = (keys: string[], kinds: CardFieldKind[]) => {
    for (const k of keys) if (o[k] !== undefined && !kinds.includes(f.kind)) fail(`${where}.${k} goes only with kind ${kinds.join(' or ')}`);
  };
  only(['maxLength'], ['text', 'textarea']);
  only(['min', 'max'], ['number']);
  only(['options'], ['select']);
  only(['placeholder'], ['text', 'textarea', 'number']);
  if (o.maxLength !== undefined) f.maxLength = Math.floor(int(o.maxLength, `${where}.maxLength`, 1, CARD_LIMITS.valueMax));
  if (o.min !== undefined) f.min = int(o.min, `${where}.min`, -1e12, 1e12);
  if (o.max !== undefined) f.max = int(o.max, `${where}.max`, -1e12, 1e12);
  if (f.min !== undefined && f.max !== undefined && f.min > f.max) fail(`${where}.min is more than its max`);
  if (f.kind === 'select') {
    if (o.options === undefined) fail(`${where}.options is required for a select`);
    f.options = options(o.options, `${where}.options`, 1, CARD_LIMITS.selectOptions);
  }
  if (secretWording(f.id, f.label, f.placeholder, ...(f.options ?? []).map((x) => x.label))) {
    fail(`${where} asks for what looks like a password, key, code or other secret. Cards never take secrets: their answers go into the chat. Ask your owner to sign in or enter it in Settings instead.`);
  }
  return f;
}

function block(v: unknown, where: string): CardBlock {
  const type = (typeof v === 'object' && v !== null ? (v as Record<string, unknown>).type : undefined) as CardBlock['type'] | undefined;
  switch (type) {
    case 'text': {
      const o = object(v, where, ['type', 'text'], ['text']);
      return { type, text: cleanText(o.text, `${where}.text`, CARD_LIMITS.text, { multiline: true }) };
    }
    case 'status': {
      const o = object(v, where, ['type', 'tone', 'text'], ['tone', 'text']);
      const tones: CardTone[] = ['info', 'success', 'warning', 'error', 'working'];
      if (!tones.includes(o.tone as CardTone)) fail(`${where}.tone must be one of ${tones.join(', ')}`);
      return { type, tone: o.tone as CardTone, text: cleanText(o.text, `${where}.text`, CARD_LIMITS.status) };
    }
    case 'progress': {
      const o = object(v, where, ['type', 'label', 'value', 'max'], ['label', 'value', 'max']);
      const max = int(o.max, `${where}.max`, 1, 1e12);
      return { type, label: cleanText(o.label, `${where}.label`, CARD_LIMITS.label), value: int(o.value, `${where}.value`, 0, max), max };
    }
    case 'table': {
      const o = object(v, where, ['type', 'columns', 'rows'], ['columns', 'rows']);
      const columns = list(o.columns, `${where}.columns`, 1, CARD_LIMITS.columns).map((c, i) => cleanText(c, `${where}.columns[${i}]`, CARD_LIMITS.optionLabel));
      const rows = list(o.rows, `${where}.rows`, 0, CARD_LIMITS.rows).map((r, i) =>
        list(r, `${where}.rows[${i}]`, columns.length, columns.length).map((c, j): CardCell => {
          const at = `${where}.rows[${i}][${j}]`;
          if (c === null) return null;
          if (typeof c === 'number') return int(c, at, -1e15, 1e15);
          return cleanText(c, at, CARD_LIMITS.cell, { required: false });
        }),
      );
      return { type, columns, rows };
    }
    case 'file': {
      const o = object(v, where, ['type', 'path', 'title'], ['path']);
      const path = cleanText(o.path, `${where}.path`, CARD_LIMITS.path);
      return { type, path, ...(o.title !== undefined ? { title: cleanText(o.title, `${where}.title`, CARD_LIMITS.label) } : {}) };
    }
    case 'link': {
      const o = object(v, where, ['type', 'url', 'label'], ['url', 'label']);
      const url = cleanText(o.url, `${where}.url`, CARD_LIMITS.url);
      const problem = safeLinkProblem(url);
      if (problem) fail(`${where}.url ${problem}`);
      return { type, url: new URL(url).href, label: cleanText(o.label, `${where}.label`, CARD_LIMITS.label) };
    }
    case 'choice': {
      const o = object(v, where, ['type', 'id', 'prompt', 'options'], ['id', 'prompt', 'options']);
      return { type, id: id(o.id, `${where}.id`), prompt: cleanText(o.prompt, `${where}.prompt`, CARD_LIMITS.status), options: options(o.options, `${where}.options`, 2, CARD_LIMITS.options) };
    }
    case 'form': {
      const o = object(v, where, ['type', 'id', 'prompt', 'fields', 'submit'], ['id', 'fields']);
      const seen = new Set<string>();
      const fields = list(o.fields, `${where}.fields`, 1, CARD_LIMITS.fields).map((f, i) => {
        const out = field(f, `${where}.fields[${i}]`);
        if (seen.has(out.id)) fail(`${where}.fields has the id "${out.id}" twice`);
        seen.add(out.id);
        return out;
      });
      const prompt = o.prompt === undefined ? undefined : cleanText(o.prompt, `${where}.prompt`, CARD_LIMITS.status);
      if (secretWording(prompt)) fail(`${where}.prompt asks for what looks like a secret. Cards never take secrets: their answers go into the chat.`);
      return {
        type,
        id: id(o.id, `${where}.id`),
        ...(prompt ? { prompt } : {}),
        fields,
        ...(o.submit !== undefined ? { submit: cleanText(o.submit, `${where}.submit`, CARD_LIMITS.submit) } : {}),
      };
    }
    case 'connector': {
      const o = object(v, where, ['type', 'connectorId'], ['connectorId']);
      if (typeof o.connectorId !== 'string' || !CONNECTOR_ID.test(o.connectorId)) fail(`${where}.connectorId must be a connector id from \`botons connector list\`, such as lib:github`);
      return { type, connectorId: o.connectorId as string };
    }
    default:
      return fail(`${where}.type must be one of text, status, progress, table, file, link, choice, form, connector`);
  }
}

/** The card a Boton posted, checked and normalized; throws CardError with what is wrong. */
export function parseCard(input: unknown): CardDescriptor {
  const o = object(input, 'card', ['v', 'title', 'blocks'], ['v', 'title', 'blocks']);
  if (o.v !== CARD_VERSION) fail(`card.v must be ${CARD_VERSION}`);
  const blocks = list(o.blocks, 'card.blocks', 1, CARD_LIMITS.blocks).map((b, i) => block(b, `card.blocks[${i}]`));
  if (blocks.filter(isInteractive).length > 1) fail('A card has at most one choice, form or connector block: post another card for another question');
  const card: CardDescriptor = { v: CARD_VERSION, title: cleanText(o.title, 'card.title', CARD_LIMITS.title), blocks };
  if (JSON.stringify(card).length > CARD_LIMITS.bytes) fail(`The card is too big (max ${CARD_LIMITS.bytes} characters of JSON)`);
  return card;
}

export function isInteractive(b: CardBlock): b is InteractiveBlock {
  return b.type === 'choice' || b.type === 'form' || b.type === 'connector';
}

export function interactiveBlock(card: CardDescriptor): InteractiveBlock | null {
  return card.blocks.find(isInteractive) ?? null;
}

/** The owner's answer, checked against the card as the server saved it (never one the client sends). */
export function parseAnswer(card: CardDescriptor, input: unknown): CardAnswerInput {
  const action = typeof input === 'object' && input !== null ? (input as Record<string, unknown>).action : undefined;
  const ask = interactiveBlock(card);
  if (!ask) fail('This card has nothing to answer');
  switch (action) {
    case 'decline':
      object(input, 'answer', ['action']);
      return { action };
    case 'choose': {
      const o = object(input, 'answer', ['action', 'option'], ['option']);
      if (ask!.type !== 'choice') fail('This card has no choice to make');
      const choice = ask as Extract<CardBlock, { type: 'choice' }>;
      if (typeof o.option !== 'string' || !choice.options.some((x) => x.id === o.option)) fail('option must be one of the card’s options');
      return { action, option: o.option as string };
    }
    case 'grant':
      object(input, 'answer', ['action']);
      if (ask!.type !== 'connector') fail('This card asks for no connector');
      return { action };
    case 'submit': {
      const o = object(input, 'answer', ['action', 'values'], ['values']);
      if (ask!.type !== 'form') fail('This card has no form');
      return { action, values: formValues((ask as Extract<CardBlock, { type: 'form' }>).fields, o.values) };
    }
    default:
      return fail('action must be one of choose, submit, grant, decline');
  }
}

/** Every value checked against its field: known fields only, of their kind and bounds, text cleaned. */
export function formValues(fields: CardField[], input: unknown): Record<string, string | number | boolean> {
  const o = object(
    input,
    'values',
    fields.map((f) => f.id),
  );
  const out: Record<string, string | number | boolean> = {};
  for (const f of fields) {
    const v = o[f.id];
    const where = `values.${f.id}`;
    const empty = v === undefined || v === null || v === '';
    if (f.kind === 'checkbox') {
      if (!empty && typeof v !== 'boolean') fail(`${where} must be true or false`);
      if (f.required && v !== true) fail(`${f.label} must be checked`);
      out[f.id] = v === true;
      continue;
    }
    if (empty) {
      if (f.required) fail(`${f.label} is required`);
      continue;
    }
    if (f.kind === 'number') {
      const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
      if (typeof n !== 'number' || !Number.isFinite(n)) fail(`${f.label} must be a number`);
      if (f.min !== undefined && (n as number) < f.min) fail(`${f.label} must be at least ${f.min}`);
      if (f.max !== undefined && (n as number) > f.max) fail(`${f.label} must be at most ${f.max}`);
      out[f.id] = n as number;
    } else if (f.kind === 'select') {
      if (typeof v !== 'string' || !f.options!.some((x) => x.id === v)) fail(`${f.label} must be one of its options`);
      out[f.id] = v as string;
    } else {
      const t = cleanText(v, f.label, f.maxLength ?? CARD_LIMITS.valueMax, { multiline: f.kind === 'textarea', required: false });
      if (!t && f.required) fail(`${f.label} is required`);
      if (t) out[f.id] = t;
    }
  }
  return out;
}

/** The answer in words, for the transcript and the Boton's turn. */
export function answerText(card: CardDescriptor, answer: CardAnswer): string {
  const ask = interactiveBlock(card);
  const title = `“${card.title}”`;
  switch (answer.action) {
    case 'decline':
      return `Declined ${title}`;
    case 'grant':
      return answer.result === 'already' ? `Answered ${title}: the connector was already there` : `Answered ${title}: gave the connector`;
    case 'choose':
      return `Answered ${title}: ${answer.option?.label ?? ''}`;
    case 'submit': {
      const fields = ask?.type === 'form' ? ask.fields : [];
      const lines = fields.map((f) => {
        const v = answer.values?.[f.id];
        const shown =
          v === undefined ? '(left empty)' : typeof v === 'boolean' ? (v ? 'yes' : 'no') : f.kind === 'select' ? (f.options?.find((x) => x.id === v)?.label ?? String(v)) : String(v);
        return `- ${f.label}: ${shown.includes('\n') ? `\n  ${shown.split('\n').join('\n  ')}` : shown}`;
      });
      return `Answered ${title}:\n${lines.join('\n')}`;
    }
  }
}
