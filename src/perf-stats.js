/**
 * Lightweight rolling performance tracker for frame-stage timings.
 * Stores a ring buffer per metric and computes percentiles on demand.
 */
export class PerfStats {
  constructor(metricNames, sampleSize = 240) {
    this._sampleSize = sampleSize;
    this._metrics = new Map();
    for (const name of metricNames) {
      this._metrics.set(name, {
        last: 0,
        count: 0,
        total: 0,
        max: 0,
        samples: new Float32Array(sampleSize),
        nextIndex: 0,
        filled: 0,
      });
    }
  }

  record(name, value) {
    let metric = this._metrics.get(name);
    if (!metric) {
      metric = {
        last: 0,
        count: 0,
        total: 0,
        max: 0,
        samples: new Float32Array(this._sampleSize),
        nextIndex: 0,
        filled: 0,
      };
      this._metrics.set(name, metric);
    }

    metric.last = value;
    metric.count++;
    metric.total += value;
    if (value > metric.max) metric.max = value;
    metric.samples[metric.nextIndex] = value;
    metric.nextIndex = (metric.nextIndex + 1) % this._sampleSize;
    if (metric.filled < this._sampleSize) metric.filled++;
  }

  snapshot() {
    const out = {};
    for (const [name, metric] of this._metrics.entries()) {
      const sampleCount = metric.filled;
      const ordered = Array.from(metric.samples.slice(0, sampleCount)).sort((a, b) => a - b);
      out[name] = {
        last: round(metric.last),
        avg: round(metric.count > 0 ? metric.total / metric.count : 0),
        p50: round(percentile(ordered, 0.5)),
        p95: round(percentile(ordered, 0.95)),
        max: round(metric.max),
        samples: sampleCount,
      };
    }
    return out;
  }

  reset() {
    for (const metric of this._metrics.values()) {
      metric.last = 0;
      metric.count = 0;
      metric.total = 0;
      metric.max = 0;
      metric.samples.fill(0);
      metric.nextIndex = 0;
      metric.filled = 0;
    }
  }
}

function percentile(sortedValues, ratio) {
  if (sortedValues.length === 0) return 0;
  const idx = Math.min(sortedValues.length - 1, Math.max(0, Math.floor((sortedValues.length - 1) * ratio)));
  return sortedValues[idx];
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}
