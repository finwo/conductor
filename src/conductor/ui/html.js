// src/conductor/ui/html.js - HTML templating
//
// A tagged template that escapes every interpolated value unless it is
// explicitly marked safe. Repository names, commit subjects, job output and
// user names all reach these pages, so escaping is the default and opting
// out has to be written down.
//
//   html`<td>${project.name}</td>`          escaped
//   html`<tbody>${rows.map(renderRow)}</tbody>`  nested templates kept
//   html`<div>${raw(trustedMarkup)}</div>`  passed through
//
// There is no dependency here on purpose: the interface is a few pages of
// tables, which does not justify a template engine or a build step.

const RAW = Symbol('raw');

export function raw(value) {
  return { [RAW]: String(value) };
}

export function isRaw(value) {
  return value !== null && typeof value === 'object' && Object.hasOwn(value, RAW);
}

const ESCAPES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function esc(value) {
  if (value === null || value === undefined || value === false) return '';
  return String(value).replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

function render(value) {
  if (value === null || value === undefined || value === false || value === true) return '';
  if (isRaw(value)) return value[RAW];
  if (Array.isArray(value)) return value.map(render).join('');
  return esc(value);
}

export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i += 1) {
    out += render(values[i]) + strings[i + 1];
  }
  return raw(out);
}

// Renders a completed template to a string for sending.
export function toHtml(value) {
  return render(value);
}

// Attribute helper for optional attributes, so a page does not have to
// build strings by hand.
export function attrs(map) {
  const parts = [];
  for (const [key, value] of Object.entries(map)) {
    if (value === null || value === undefined || value === false) continue;
    if (value === true) parts.push(esc(key));
    else parts.push(`${esc(key)}="${esc(value)}"`);
  }
  return raw(parts.join(' '));
}
