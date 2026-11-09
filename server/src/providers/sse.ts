/** One server-sent event: its `event:` name ("message" when it has none) and its `data:` lines joined. */
export interface SseEvent {
  event: string;
  data: string;
}

export class StreamError extends Error {
  /** The stream ended (or broke) before the provider said its answer was complete. */
  constructor(message: string) {
    super(message);
  }
}

/**
 * The events of a streamed answer, in order. Bounded: at most `maxBytes` in all and `maxEvent` per event, and no
 * gap longer than `idleMs` between chunks (a provider that went silent ends the turn rather than hold it).
 */
export async function* sseEvents(body: ReadableStream<Uint8Array>, opts: { maxBytes: number; maxEvent: number; idleMs: number; signal: AbortSignal }): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let total = 0;
  try {
    for (;;) {
      let timer: NodeJS.Timeout | undefined;
      const idle = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new StreamError(`no data for ${Math.round(opts.idleMs / 1000)} s`)), opts.idleMs);
      });
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await Promise.race([reader.read(), idle]);
      } finally {
        clearTimeout(timer);
      }
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > opts.maxBytes) throw new StreamError('the answer was larger than Botons reads');
      buf += decoder.decode(chunk.value, { stream: true });
      let at: number;
      while ((at = boundary(buf)) >= 0) {
        const block = buf.slice(0, at);
        buf = buf.slice(at).replace(/^(\r?\n){2}|^\r\r/, '');
        const ev = parse(block);
        if (ev) yield ev;
      }
      if (buf.length > opts.maxEvent) throw new StreamError('one event of the answer was larger than Botons reads');
    }
    buf += decoder.decode();
    const last = parse(buf);
    if (last) yield last;
  } finally {
    reader.cancel().catch(() => {});
  }
}

function boundary(buf: string): number {
  const m = /\r?\n\r?\n|\r\r/.exec(buf);
  return m ? m.index : -1;
}

function parse(block: string): SseEvent | null {
  let event = 'message';
  const data: string[] = [];
  for (const line of block.split(/\r?\n|\r/)) {
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  return data.length ? { event, data: data.join('\n') } : null;
}
