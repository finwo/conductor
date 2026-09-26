// web/src/util/ansi.ts - terminal colour codes into vnodes
//
// Vnodes, never markup: a log must not be able to become a tag.

import m from 'mithril';

const COLOURS = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'];

// Cursor moves, erases, and the carriage return a progress bar leaves.
const NOISE = /\u001b\[[0-9;?]*[A-Za-z]|\u001b\][^\u0007]*\u0007|\r(?!\n)/g;

type Style = { fg?: string; bg?: string; bold?: boolean; faint?: boolean; italic?: boolean; underline?: boolean };

function classOf(style: Style): string {
  const parts: string[] = [];
  if (style.fg) parts.push(`fg-${style.fg}`);
  if (style.bg) parts.push(`bg-${style.bg}`);
  if (style.bold) parts.push('bold');
  if (style.faint) parts.push('faint');
  if (style.italic) parts.push('italic');
  if (style.underline) parts.push('underline');
  return parts.join(' ');
}

function apply(style: Style, codes: number[]): Style {
  let next = { ...style };
  for (const code of codes) {
    if (code === 0) next = {};
    else if (code === 1) next.bold = true;
    else if (code === 2) next.faint = true;
    else if (code === 3) next.italic = true;
    else if (code === 4) next.underline = true;
    else if (code === 22) { next.bold = false; next.faint = false; }
    else if (code === 23) next.italic = false;
    else if (code === 24) next.underline = false;
    else if (code >= 30 && code <= 37) next.fg = COLOURS[code - 30];
    else if (code === 39) next.fg = undefined;
    else if (code >= 40 && code <= 47) next.bg = COLOURS[code - 40];
    else if (code === 49) next.bg = undefined;
    else if (code >= 90 && code <= 97) next.fg = `bright-${COLOURS[code - 90]}`;
    else if (code >= 100 && code <= 107) next.bg = `bright-${COLOURS[code - 100]}`;
  }
  return next;
}

export function ansi(text: string): m.Children {
  const out: m.Children[] = [];
  let style: Style = {};
  let at = 0;

  const sgr = /\u001b\[([0-9;]*)m/g;
  let match = sgr.exec(text);

  const push = (chunk: string) => {
    if (!chunk) return;
    const clean = chunk.replace(NOISE, '');
    if (!clean) return;
    const name = classOf(style);
    out.push(name ? m('span', { class: name }, clean) : clean);
  };

  while (match !== null) {
    push(text.slice(at, match.index));
    const codes = match[1].split(';').filter(Boolean).map(Number);
    style = apply(style, codes.length > 0 ? codes : [0]);
    at = match.index + match[0].length;
    match = sgr.exec(text);
  }
  push(text.slice(at));

  return out;
}
