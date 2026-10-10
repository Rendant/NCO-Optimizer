/**
 * Best-layout exchange between optimizer workers through a SharedArrayBuffer:
 * [0] Int32 spin lock, [1] Int32 version, bytes 8..15 Float64 objective, bytes 16.. layout.
 */
export function createExchange(n: number) {
  const buf = new SharedArrayBuffer(16 + n);
  new Float64Array(buf, 8, 1)[0] = -Infinity;
  return buf;
}

export function exchangeHooks(buf: SharedArrayBuffer) {
  const ctl = new Int32Array(buf, 0, 2), obj = new Float64Array(buf, 8, 1), grid = new Uint8Array(buf, 16);
  const lock = () => { while (Atomics.compareExchange(ctl, 0, 0, 1) !== 0) { /* spin: critical sections are tiny */ } };
  const unlock = () => Atomics.store(ctl, 0, 0);
  let seen = 0;
  return {
    publish(g: Uint8Array, objective: number) {
      if (g.length !== grid.length) return;
      lock();
      try { if (objective > obj[0]) { obj[0] = objective; grid.set(g); Atomics.add(ctl, 1, 1); } } finally { unlock(); }
    },
    fetch(): { grid: Uint8Array; objective: number } | null {
      if (Atomics.load(ctl, 1) === seen) return null;
      lock();
      try { seen = Atomics.load(ctl, 1); return { grid: grid.slice(), objective: obj[0] }; } finally { unlock(); }
    },
  };
}
