/*
 * The live view of a handover (the owner driving a Boton's browser), as pure parts both sides use: the stream's
 * chunks, and where a point on the owner's screen lands in the page.
 *
 * The stream is one long response of chunks, each a kind byte, a 4-byte big-endian length, then that many bytes:
 * LIVE_FRAME is a frame (2 bytes each of its CSS width and height, then the JPEG), LIVE_NOTICE a notice (UTF-8
 * JSON, a HandoverNotice). It imports nothing.
 */

export const LIVE_FRAME = 1;
export const LIVE_NOTICE = 2;
/** No chunk is longer (a frame of the largest page at twice its pixels is far less). */
export const LIVE_CHUNK_MAX = 16 * 1024 * 1024;

function chunk(kind: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(5 + payload.length);
  out[0] = kind;
  new DataView(out.buffer).setUint32(1, payload.length);
  out.set(payload, 5);
  return out;
}

export function liveFrame(jpeg: Uint8Array, width: number, height: number): Uint8Array {
  const body = new Uint8Array(4 + jpeg.length);
  const v = new DataView(body.buffer);
  v.setUint16(0, Math.max(0, Math.min(0xffff, Math.round(width))));
  v.setUint16(2, Math.max(0, Math.min(0xffff, Math.round(height))));
  body.set(jpeg, 4);
  return chunk(LIVE_FRAME, body);
}

export function liveNotice(notice: unknown): Uint8Array {
  return chunk(LIVE_NOTICE, new TextEncoder().encode(JSON.stringify(notice)));
}

export type LiveChunk = { kind: 'frame'; width: number; height: number; jpeg: Uint8Array } | { kind: 'notice'; notice: unknown };

/** Reads chunks from the stream's bytes as they arrive, in whatever pieces the network gives them. */
export class LiveParser {
  #buf = new Uint8Array(0);

  push(piece: Uint8Array): LiveChunk[] {
    const joined = new Uint8Array(this.#buf.length + piece.length);
    joined.set(this.#buf);
    joined.set(piece, this.#buf.length);
    const out: LiveChunk[] = [];
    let at = 0;
    while (joined.length - at >= 5) {
      const v = new DataView(joined.buffer, joined.byteOffset + at);
      const kind = v.getUint8(0);
      const len = v.getUint32(1);
      if (len > LIVE_CHUNK_MAX) throw new Error('The live view sent a chunk too large to be one');
      if (joined.length - at - 5 < len) break;
      const body = joined.slice(at + 5, at + 5 + len);
      at += 5 + len;
      if (kind === LIVE_FRAME && body.length >= 4) {
        const b = new DataView(body.buffer);
        out.push({ kind: 'frame', width: b.getUint16(0), height: b.getUint16(2), jpeg: body.slice(4) });
      } else if (kind === LIVE_NOTICE) {
        try {
          out.push({ kind: 'notice', notice: JSON.parse(new TextDecoder().decode(body)) });
        } catch {}
      }
    }
    this.#buf = joined.slice(at);
    return out;
  }
}

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Where the owner's pointer at (`clientX`, `clientY`) lands in the page: `box` is the view's box on screen, in which
 * the frame is drawn whole and centred (object-fit: contain, so a frame of another shape leaves bands), and `page` the
 * page's size in CSS pixels that the frame shows. Null on a band or outside the frame. Screen pixel ratios cancel out:
 * the box and the client point are both CSS pixels of the owner's screen, and the page is CSS pixels of the page.
 */
export function toPagePoint(clientX: number, clientY: number, box: Rect, page: { width: number; height: number }): { x: number; y: number } | null {
  if (!(box.width > 0 && box.height > 0 && page.width > 0 && page.height > 0)) return null;
  const scale = Math.min(box.width / page.width, box.height / page.height);
  const drawnW = page.width * scale;
  const drawnH = page.height * scale;
  const left = box.left + (box.width - drawnW) / 2;
  const top = box.top + (box.height - drawnH) / 2;
  const x = (clientX - left) / scale;
  const y = (clientY - top) / scale;
  if (x < 0 || y < 0 || x >= page.width || y >= page.height) return null;
  return { x: Math.min(page.width - 1, Math.floor(x)), y: Math.min(page.height - 1, Math.floor(y)) };
}
