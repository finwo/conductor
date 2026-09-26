// web/src/util/poll.ts - repeat while there is still something to watch

import m from 'mithril';

type Load = () => Promise<boolean>;

// The loader says whether to keep going, so polling stops the moment an
// entity settles rather than running for as long as the page is open.
export function poll(load: Load, interval: number) {
  let timer = 0;
  let stopped = false;

  async function tick() {
    if (stopped) return;
    let again = false;
    try {
      again = await load();
    } finally {
      m.redraw();
    }
    if (again && !stopped) timer = window.setTimeout(tick, interval);
  }

  return {
    start() {
      stopped = false;
      tick();
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
  };
}
