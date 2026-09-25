// src/lib/outputs.js - values a task produced, as the conductor sees them
//
// The worker parses these out of a log stream and has its own copy of the
// rules; it shares no code with the conductor. These are the conductor's,
// applied to what a worker reports rather than trusted from it.

export const OUTPUT_NAME = /^[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z_][A-Za-z0-9_-]*)*$/;
export const MAX_OUTPUT_VALUE = 8192;
export const MAX_OUTPUTS = 64;

// Binds a sealed value to where it is stored, so a row copied onto another
// task or name fails to open.
export const outputAad = (taskId, name) => `task:${taskId}/output:${name}`;

export function readOutputList(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const entry of value.slice(0, MAX_OUTPUTS)) {
    if (!entry || typeof entry !== 'object') continue;
    const { name, value: v } = entry;
    if (typeof name !== 'string' || !OUTPUT_NAME.test(name)) continue;
    if (typeof v !== 'string' || v.length > MAX_OUTPUT_VALUE) continue;
    out.push({ name, value: v, masked: entry.masked !== false });
  }
  return out;
}
