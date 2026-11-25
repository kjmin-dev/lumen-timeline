/**
 * A waveform scale for `WaveformProvider.scale` that draws peaks by their
 * level in decibels: `floor` dB and quieter draw nothing, 0 dB draws full
 * height. Speech and other quiet material keep their shape on it.
 */
export function decibelScale(floor: number = -42): (peak: number) => number {
  if (!(Number.isFinite(floor) && floor < 0))
    throw new RangeError("A decibel floor must be a negative number");
  return (peak) => {
    const size = Math.abs(peak);
    if (!(size > 0)) return 0;
    const shown = Math.max(0, 1 - (20 * Math.log10(size)) / floor);
    return Math.sign(peak) * Math.min(1, shown);
  };
}
