// web/src/util/format.ts - timestamps, durations and sizes

const UNITS: [number, string][] = [
  [60, 'second'],
  [60, 'minute'],
  [24, 'hour'],
  [7, 'day'],
  [4.348, 'week'],
  [12, 'month'],
];

// Rendered from the clock at draw time rather than baked in, so a page left
// open does not keep insisting something happened two seconds ago.
export function ago(at: number | null | undefined, now = Date.now()): string {
  if (!at) return '';
  let value = (now - at) / 1000;
  if (value < 45) return 'just now';

  for (const [step, unit] of UNITS) {
    if (Math.abs(value) < step) {
      const n = Math.round(value);
      return `${n} ${unit}${n === 1 ? '' : 's'} ago`;
    }
    value /= step;
  }
  const years = Math.round(value);
  return `${years} year${years === 1 ? '' : 's'} ago`;
}

export function duration(from: number | null | undefined, to: number | null | undefined): string {
  if (!from) return '';
  const ms = (to ?? Date.now()) - from;
  if (ms < 0) return '';

  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;

  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function bytes(size: number | null | undefined): string {
  if (size === null || size === undefined) return '';
  if (size < 1024) return `${size} B`;

  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = size / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

export function stamp(at: number | null | undefined): string {
  return at ? new Date(at).toLocaleString() : '';
}

export function shortSha(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 8) : '';
}

const TERMINAL = ['success', 'failed', 'cancelled', 'skipped', 'timeout'];

export function settled(state: string): boolean {
  return TERMINAL.includes(state);
}
