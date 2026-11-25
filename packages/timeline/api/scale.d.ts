/**
 * A waveform scale for `WaveformProvider.scale` that draws peaks by their
 * level in decibels: `floor` dB and quieter draw nothing, 0 dB draws full
 * height. Speech and other quiet material keep their shape on it.
 */
export declare function decibelScale(floor?: number): (peak: number) => number;
