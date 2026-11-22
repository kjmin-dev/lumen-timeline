// Waveform peak kernels for wasm32 with simd128. scripts/wasm.mjs builds this
// file with Rust 1.100.0 into src/peaks-wasm.ts; packages/media/src/peaks.ts
// holds the JavaScript kernels that must return the same bits.
//
// A pair is the minimum and maximum of the finite samples in a bucket. A bucket
// with no finite sample is empty: +inf and -inf, the identity for both. Negative
// zero is stored as zero, so every backend returns the same bits whatever order
// it visits samples in.
//
// The caller validates every length and keeps input and output disjoint and
// inside this module's memory. Nothing here allocates.
#![no_std]

use core::arch::wasm32::*;

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    unreachable()
}

/// Samples in one tile.
const TILE: usize = 65536;
/// Pairs in one tile: 4,096 + 1,024 + 256 + 64 + 16 + 4.
const TILE_PAIRS: usize = 5460;
/// Buckets of the finest level, 16 samples each.
const FINEST: usize = 4096;

/// Writes the pairs of `samples` values at `input`, `per_bucket` samples to a
/// bucket and the last bucket partial, to `output`: 2 * ceil(samples /
/// per_bucket) values.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn reduce(
    input: *const f32,
    samples: usize,
    per_bucket: usize,
    output: *mut f32,
) {
    let mut start = 0;
    let mut pair = 0;
    while start < samples {
        let end = if samples - start < per_bucket {
            samples
        } else {
            start + per_bucket
        };
        let (lo, hi) = unsafe { bucket(input, start, end) };
        unsafe {
            output.add(2 * pair).write(lo + 0.0);
            output.add(2 * pair + 1).write(hi + 0.0);
        }
        start = end;
        pair += 1;
    }
}

/// Combines `pairs` pairs at `input`, `factor` to an output pair and the last
/// group partial, into 2 * ceil(pairs / factor) values at `output`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn fold(input: *const f32, pairs: usize, factor: usize, output: *mut f32) {
    let mut start = 0;
    let mut pair = 0;
    while start < pairs {
        let end = if pairs - start < factor {
            pairs
        } else {
            start + factor
        };
        let mut lo = f32::INFINITY;
        let mut hi = f32::NEG_INFINITY;
        for i in start..end {
            let (a, b) = unsafe { (input.add(2 * i).read(), input.add(2 * i + 1).read()) };
            if a < lo {
                lo = a;
            }
            if b > hi {
                hi = b;
            }
        }
        unsafe {
            output.add(2 * pair).write(lo + 0.0);
            output.add(2 * pair + 1).write(hi + 0.0);
        }
        start = end;
        pair += 1;
    }
}

/// Builds the tiles of `samples` values at `input`, one per 65,536 samples and
/// the last partial, into `output`: 2 * 5,460 values per tile. Each tile holds
/// six levels, 16 to 16,384 samples per bucket, finest first. Buckets past the
/// end of the samples are empty.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn tiles(input: *const f32, samples: usize, output: *mut f32) {
    let mut start = 0;
    let mut tile = 0;
    while start < samples {
        let count = if samples - start < TILE {
            samples - start
        } else {
            TILE
        };
        let out = unsafe { output.add(2 * TILE_PAIRS * tile) };
        unsafe { reduce(input.add(start), count, 16, out) };
        let filled = count.div_ceil(16);
        for pair in filled..FINEST {
            unsafe {
                out.add(2 * pair).write(f32::INFINITY);
                out.add(2 * pair + 1).write(f32::NEG_INFINITY);
            }
        }
        let mut from = 0;
        let mut pairs = FINEST;
        while pairs > 4 {
            unsafe { fold(out.add(2 * from), pairs, 4, out.add(2 * (from + pairs))) };
            from += pairs;
            pairs /= 4;
        }
        start += count;
        tile += 1;
    }
}

/// The extremes of the finite samples in [start, end), four lanes at a time.
#[inline(always)]
unsafe fn bucket(input: *const f32, start: usize, end: usize) -> (f32, f32) {
    let inf = f32x4_splat(f32::INFINITY);
    let ninf = f32x4_splat(f32::NEG_INFINITY);
    let mut low = inf;
    let mut high = ninf;
    let mut i = start;
    while i + 4 <= end {
        // v128_load does not require alignment.
        let values = unsafe { v128_load(input.add(i).cast()) };
        // NaN and both infinities fail this test and become each side's identity.
        let finite = f32x4_lt(f32x4_abs(values), inf);
        // pmin(a, b) is b < a ? b : a, and pmax(a, b) is a < b ? b : a.
        low = f32x4_pmin(low, v128_bitselect(values, inf, finite));
        high = f32x4_pmax(high, v128_bitselect(values, ninf, finite));
        i += 4;
    }
    let mut lo = f32::INFINITY;
    let mut hi = f32::NEG_INFINITY;
    for value in [
        f32x4_extract_lane::<0>(low),
        f32x4_extract_lane::<1>(low),
        f32x4_extract_lane::<2>(low),
        f32x4_extract_lane::<3>(low),
    ] {
        if value < lo {
            lo = value;
        }
    }
    for value in [
        f32x4_extract_lane::<0>(high),
        f32x4_extract_lane::<1>(high),
        f32x4_extract_lane::<2>(high),
        f32x4_extract_lane::<3>(high),
    ] {
        if value > hi {
            hi = value;
        }
    }
    while i < end {
        let value = unsafe { input.add(i).read() };
        if value < lo && value != f32::NEG_INFINITY {
            lo = value;
        }
        if value > hi && value != f32::INFINITY {
            hi = value;
        }
        i += 1;
    }
    (lo, hi)
}
