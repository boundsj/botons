// The part of EventSource web/src/state.ts uses, over fetch. Like a browser,
// it reconnects after a network error or the stream ending, and gives up
// (readyState CLOSED) on an HTTP error status.

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 2;

export class TestEventSource {
  static readonly CLOSED = CLOSED;
  /** Relative URLs resolve against this. */
  static base = 'http://127.0.0.1';
  static retryMs = 100;
  /** Every instance made, newest last. */
  static made: TestEventSource[] = [];

  readyState = CONNECTING;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  #url: string;
  #attempt = new AbortController();
  #closed = false;

  constructor(url: string) {
    this.#url = new URL(url, TestEventSource.base).href;
    TestEventSource.made.push(this);
    void this.#run();
  }

  close(): void {
    this.#closed = true;
    this.readyState = CLOSED;
    this.#attempt.abort();
  }

  async #run() {
    while (!this.#closed) {
      this.readyState = CONNECTING;
      this.#attempt = new AbortController();
      try {
        const res = await fetch(this.#url, { signal: this.#attempt.signal, headers: { accept: 'text/event-stream' } });
        if (this.#closed) return;
        if (!res.ok || !res.body) {
          this.readyState = CLOSED;
          this.onerror?.(new Event('error'));
          return;
        }
        this.readyState = OPEN;
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += value;
          for (let i = buf.indexOf('\n\n'); i >= 0; i = buf.indexOf('\n\n')) {
            const data = buf
              .slice(0, i)
              .split('\n')
              .filter((l) => l.startsWith('data:'))
              .map((l) => l.slice(5).replace(/^ /, ''))
              .join('\n');
            buf = buf.slice(i + 2);
            if (data && !this.#closed) this.onmessage?.(new MessageEvent('message', { data }));
          }
        }
      } catch {}
      if (this.#closed) return;
      this.readyState = CONNECTING;
      this.onerror?.(new Event('error'));
      await new Promise((r) => setTimeout(r, TestEventSource.retryMs));
    }
  }
}
