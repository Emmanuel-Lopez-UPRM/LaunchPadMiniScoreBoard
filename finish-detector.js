/* Pure image processing, shared by the browser and deterministic tests. */
(function (root) {
  'use strict';
  class FinishDetector {
    constructor(width, height, settings) {
      this.width = width; this.height = height; this.settings = settings;
      this.background = new Float32Array(width * height * 3);
      this.samples = 0; this.previous = [null, null]; this.crossings = [null, null];
      this.lastTime = null;
    }
    calibrate(rgba) {
      this.samples++;
      for (let i = 0; i < this.width * this.height; i++) {
        for (let c = 0; c < 3; c++) {
          const k = i * 3 + c;
          this.background[k] += (rgba[i * 4 + c] - this.background[k]) / this.samples;
        }
      }
    }
    process(rgba, time) {
      const { axis, reverse, line, split, margin, threshold, minPixels } = this.settings;
      const w = this.width, h = this.height;
      const mask = new Uint8Array(w * h);
      let changed = 0, relevant = 0;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const u = (axis === 'horizontal' ? x / w : y / h);
        const v = (axis === 'horizontal' ? y / h : x / w);
        if (u < margin || u > 1 - margin || Math.abs(u - split) < .025 || Math.abs(v - line) > .24) continue;
        relevant++;
        const i = y * w + x;
        let delta = 0;
        for (let c = 0; c < 3; c++) delta += Math.abs(rgba[i * 4 + c] - this.background[i * 3 + c]);
        if (delta / 3 > threshold) { mask[i] = 1; changed++; }
      }
      // A camera bump or broad lighting change must never award a point.
      if (changed > relevant * .35) { this.previous = [null, null]; return { unstable: true, crossings: this.crossings }; }
      const best = [null, null];
      for (let i = 0; i < mask.length; i++) {
        if (!mask[i]) continue;
        const queue = [i]; mask[i] = 0;
        let count = 0, front = reverse ? 1 : 0, sumU = 0;
        for (let q = 0; q < queue.length; q++) {
          const p = queue[q], x = p % w, y = Math.floor(p / w);
          const u = axis === 'horizontal' ? x / w : y / h;
          const v = axis === 'horizontal' ? y / h : x / w;
          count++; sumU += u; front = reverse ? Math.min(front, v) : Math.max(front, v);
          for (const n of [x > 0 ? p - 1 : -1, x + 1 < w ? p + 1 : -1, y > 0 ? p - w : -1, y + 1 < h ? p + w : -1]) {
            if (n >= 0 && mask[n]) { mask[n] = 0; queue.push(n); }
          }
        }
        const lane = sumU / count < split ? 0 : 1;
        if (count >= minPixels && (!best[lane] || count > best[lane].count)) best[lane] = { count, front, u: sumU / count, time };
      }
      best.forEach((now, lane) => {
        const prev = this.previous[lane];
        if (now && prev && !this.crossings[lane] && time - prev.time > 0 && time - prev.time <= .25 && Math.abs(now.u - prev.u) < .15) {
          const from = reverse ? line - prev.front : prev.front - line;
          const to = reverse ? line - now.front : now.front - line;
          if (from < 0 && to >= 0) {
            // The exact crossing is unknown between frames: keep the whole interval.
            this.crossings[lane] = { before: prev.time, after: time };
          }
        }
        if (now) this.previous[lane] = now;
        else if (prev && time - prev.time > .15) this.previous[lane] = null;
      });
      this.lastTime = time;
      return { unstable: false, crossings: this.crossings, objects: best };
    }
  }
  function decide(crossings, now, wait = .15) {
    const [a, b] = crossings;
    if (!a && !b) return null;
    if (a && b) {
      if (a.after < b.before) return { winner: 'a', close: false };
      if (b.after < a.before) return { winner: 'b', close: false };
      return { winner: null, close: true };
    }
    const first = a || b;
    return now - first.after >= wait ? { winner: a ? 'a' : 'b', close: false } : null;
  }
  root.RaceVision = { FinishDetector, decide };
  if (typeof module !== 'undefined') module.exports = root.RaceVision;
})(typeof window !== 'undefined' ? window : globalThis);
