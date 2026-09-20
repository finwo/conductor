// src/worker/logstream.js - batching log shipper with masking
//
// Task output arrives as many small writes; shipping each one would be a
// request per line. Output is accumulated and flushed on a timer, or as soon
// as it grows past a threshold.
//
// The offset the conductor has accepted is tracked locally, so a retry after
// a dropped connection resends from the right place rather than duplicating
// or losing output. A 409 carries the conductor's view of the offset and
// wins, since it is the side holding the file.
//
// Masking happens here, before anything leaves the host. Two details make it
// actually work:
//
//   Masking is applied when a batch is assembled, not as each write
//   arrives, and the last few characters are held back until more output
//   appears. A secret written across two chunks is therefore still matched.
//   Masking each write on its own would defeat the hold back entirely.
//
//   While masking is active the stream is decoded as UTF-8 with a
//   StringDecoder, so a multi byte character split across writes is not
//   mangled. With no secrets configured the bytes are passed through
//   untouched and the stream stays binary safe.

import { StringDecoder } from 'node:string_decoder';

const FLUSH_BYTES = 16 * 1024;
const FLUSH_MS = 1000;
const REDACTION = '[masked]';

// Below this length a value is too common to redact usefully, and would
// turn ordinary output into noise.
const MIN_SECRET_LENGTH = 4;

export function createLogStream(client, url, { masked = [], flushMs = FLUSH_MS, logger = console } = {}) {
  // Longest first, so an overlapping shorter secret cannot partially
  // reveal a longer one.
  const secrets = [...new Set(masked.filter((s) => typeof s === 'string' && s.length >= MIN_SECRET_LENGTH))]
    .sort((a, b) => b.length - a.length);
  const masking = secrets.length > 0;
  const holdBack = masking ? Math.max(...secrets.map((s) => s.length)) - 1 : 0;

  const decoder = masking ? new StringDecoder('utf8') : null;
  let text = '';
  let bytes = Buffer.alloc(0);
  let outbox = Buffer.alloc(0);

  let offset = 0;
  let timer = null;
  let flushing = null;
  let ended = false;
  let failed = null;

  function mask(value) {
    let out = value;
    for (const secret of secrets) out = out.split(secret).join(REDACTION);
    return out;
  }

  function buffered() {
    return outbox.length + (masking ? text.length : bytes.length);
  }

  // Moves everything that is safe to send into the outbox, masking on the
  // way. Anything within holdBack of the end waits for more input, unless
  // this is the final flush.
  function assemble(final) {
    if (!masking) {
      if (bytes.length === 0) return;
      outbox = Buffer.concat([outbox, bytes]);
      bytes = Buffer.alloc(0);
      return;
    }

    if (final) text += decoder.end();
    const keep = final ? 0 : Math.min(holdBack, text.length);
    const take = text.slice(0, text.length - keep);
    text = text.slice(text.length - keep);
    if (take.length === 0) return;
    outbox = Buffer.concat([outbox, Buffer.from(mask(take), 'utf8')]);
  }

  function schedule() {
    if (timer !== null || ended) return;
    timer = setTimeout(() => { timer = null; void flush(); }, flushMs);
    timer.unref?.();
  }

  async function flush(final = false) {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    // Serialize, so two flushes cannot race on the offset.
    while (flushing) await flushing;

    assemble(final);
    if (outbox.length === 0) return;

    flushing = (async () => {
      while (outbox.length > 0) {
        const chunk = outbox;
        outbox = Buffer.alloc(0);
        try {
          const result = await client.appendLog(url, chunk, offset);
          if (result.conflict) {
            // The conductor knows what it already has; drop that much and
            // resend the remainder.
            const skip = result.expected - offset;
            offset = result.expected;
            const remainder = skip > 0 ? chunk.subarray(Math.min(skip, chunk.length)) : chunk;
            outbox = Buffer.concat([remainder, outbox]);
            continue;
          }
          offset = result.size;
        } catch (e) {
          // Losing log output must not fail an otherwise good task.
          failed = e;
          logger.warn?.(`log shipping failed, dropping ${chunk.length} bytes: ${e.message}`);
        }
      }
    })();

    try {
      await flushing;
    } finally {
      flushing = null;
    }
  }

  return {
    write(chunk) {
      if (ended) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
      if (masking) text += decoder.write(buffer);
      else bytes = Buffer.concat([bytes, buffer]);

      if (buffered() >= FLUSH_BYTES) void flush();
      else schedule();
    },

    // A line from the worker rather than the task, so the log can explain a
    // timeout, a cancellation or a setup failure.
    note(line) {
      this.write(`${line}\n`);
    },

    async close() {
      if (ended) return;
      await flush(true);
      ended = true;
    },

    get offset() {
      return offset;
    },

    get error() {
      return failed;
    },
  };
}
