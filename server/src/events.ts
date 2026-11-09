import type { ServerEvent } from '../../shared/types.ts';
import { log } from './log.ts';

type Listener = (event: ServerEvent) => void;

/** In-process pub/sub that fans server events out to SSE clients and internal waiters. */
export class EventHub {
  #listeners = new Set<Listener>();
  #streams = new Set<() => void>();

  publish(event: ServerEvent): void {
    for (const l of this.#listeners) {
      try {
        l(event);
      } catch (err) {
        log.error('event listener failed', { event: event.type, err });
      }
    }
  }

  get listenerCount(): number {
    return this.#listeners.size;
  }

  addStream(end: () => void): () => void {
    this.#streams.add(end);
    return () => this.#streams.delete(end);
  }

  /** At shutdown. Ending (not destroying) a response still sends what was written to it, such as a turn's last events. */
  endStreams(): void {
    for (const end of [...this.#streams]) {
      try {
        end();
      } catch (err) {
        log.debug('could not end an event stream', { err });
      }
    }
    this.#streams.clear();
  }

  subscribe(l: Listener): () => void {
    this.#listeners.add(l);
    return () => this.#listeners.delete(l);
  }
}
