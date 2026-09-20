/**
 * Time-stretch (WSOLA) so speech can change tempo without changing pitch.
 * `rate` > 1 is faster (shorter output). Chunk edges stay at full amplitude
 * so concatenated TTS grains do not dip at boundaries.
 */
export function timeStretch(input: Float32Array, rate: number, sampleRate: number): Float32Array {
  if (input.length === 0) return input;
  if (!Number.isFinite(rate) || rate <= 0) return input;
  if (Math.abs(rate - 1) < 0.001) return input;

  const grainSize = evenSize(Math.round(sampleRate * 0.03));
  if (input.length <= grainSize) return input;

  const hopOut = grainSize >> 1;
  const overlap = grainSize - hopOut;
  const hopIn = hopOut * rate;
  const search = Math.max(16, Math.round(sampleRate * 0.005));

  const estimated = Math.max(grainSize, Math.round(input.length / rate));
  const output = new Float32Array(estimated + grainSize);

  let read = 0;
  let write = 0;
  let first = true;

  while (write + grainSize <= output.length) {
    let start = Math.round(read);
    if (!first) {
      start += bestOffset(input, start, output, write, overlap, search);
    }
    start = clamp(start, 0, input.length - grainSize);

    if (first) {
      output.set(input.subarray(start, start + grainSize), write);
      first = false;
    } else {
      for (let i = 0; i < overlap; i += 1) {
        const t = i / overlap;
        output[write + i] = output[write + i] * (1 - t) + input[start + i] * t;
      }
      output.set(input.subarray(start + overlap, start + grainSize), write + overlap);
    }

    read += hopIn;
    write += hopOut;
    if (start + grainSize >= input.length) break;
  }

  const length = Math.min(output.length, Math.max(estimated, write + overlap));
  return output.subarray(0, length);
}

function evenSize(value: number): number {
  const size = Math.max(32, value);
  return size + (size % 2);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function bestOffset(
  input: Float32Array,
  center: number,
  output: Float32Array,
  write: number,
  overlap: number,
  search: number,
): number {
  const lo = Math.max(-search, -center);
  const hi = Math.min(search, input.length - overlap - center);
  if (hi < lo) return 0;

  let best = 0;
  let bestErr = Infinity;
  for (let offset = lo; offset <= hi; offset += 1) {
    let err = 0;
    const inputStart = center + offset;
    for (let i = 0; i < overlap; i += 1) {
      const delta = output[write + i] - input[inputStart + i];
      err += delta * delta;
    }
    if (err < bestErr) {
      bestErr = err;
      best = offset;
    }
  }
  return best;
}
