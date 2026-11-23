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

const INF: v128 = f32x4(f32::INFINITY, f32::INFINITY, f32::INFINITY, f32::INFINITY);
const NEG_INF: v128 = f32x4(
    f32::NEG_INFINITY,
    f32::NEG_INFINITY,
    f32::NEG_INFINITY,
    f32::NEG_INFINITY,
);
const ZERO: v128 = f32x4(0.0, 0.0, 0.0, 0.0);

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
///
/// The finest level reduces four buckets at a time and the coarser levels fold
/// two pairs at a time; both return the bits `reduce` and `fold` would.
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
        unsafe { finest(input.add(start), count, out) };
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
            unsafe { fold4(out.add(2 * from), pairs, out.add(2 * (from + pairs))) };
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

/// The finest level of one tile, 16 samples a bucket: whole groups of four
/// buckets through `four`, the rest, with any partial bucket, through `reduce`.
#[inline(always)]
unsafe fn finest(input: *const f32, samples: usize, output: *mut f32) {
    let groups = samples / 64;
    for group in 0..groups {
        unsafe { four(input.add(64 * group), output.add(8 * group)) };
    }
    if 64 * groups < samples {
        unsafe {
            reduce(
                input.add(64 * groups),
                samples - 64 * groups,
                16,
                output.add(8 * groups),
            )
        };
    }
}

/// Four 16-sample buckets to four pairs, without the finite test `bucket`
/// makes. pmin(acc, v) is `v < acc ? v : acc` and pmax(acc, v) is `acc < v ?
/// v : acc`, so with the sample second a NaN never enters an extreme and +inf
/// never enters a minimum, nor -inf a maximum. Only -inf can reach a minimum
/// and +inf a maximum; a group where either did is reduced again by `reduce`,
/// which leaves both out. A bucket of only NaN and infinities still comes out
/// empty, +inf over -inf.
#[inline(always)]
unsafe fn four(input: *const f32, output: *mut f32) {
    let mut lows = [INF; 4];
    let mut highs = [NEG_INF; 4];
    for b in 0..4 {
        for k in 0..4 {
            // v128_load does not require alignment. The sample must stay the
            // second argument: first, a NaN would replace the extreme.
            let v = unsafe { v128_load(input.add(16 * b + 4 * k).cast()) };
            lows[b] = f32x4_pmin(lows[b], v);
            highs[b] = f32x4_pmax(highs[b], v);
        }
    }
    let lo = minima(lows);
    let hi = maxima(highs);
    if v128_any_true(v128_or(f32x4_eq(lo, NEG_INF), f32x4_eq(hi, INF))) {
        unsafe { reduce(input, 64, 16, output) };
        return;
    }
    // Interleave to lo, hi pairs; adding zero stores negative zero as zero.
    unsafe {
        v128_store(
            output.cast(),
            f32x4_add(i32x4_shuffle::<0, 4, 1, 5>(lo, hi), ZERO),
        );
        v128_store(
            output.add(4).cast(),
            f32x4_add(i32x4_shuffle::<2, 6, 3, 7>(lo, hi), ZERO),
        );
    }
}

/// Lane b of the result is the least lane of `v[b]`. No lane is NaN, so the
/// order of comparisons changes at most the sign of a zero.
#[inline(always)]
fn minima(v: [v128; 4]) -> v128 {
    let ab = f32x4_pmin(
        i32x4_shuffle::<0, 1, 4, 5>(v[0], v[1]),
        i32x4_shuffle::<2, 3, 6, 7>(v[0], v[1]),
    );
    let cd = f32x4_pmin(
        i32x4_shuffle::<0, 1, 4, 5>(v[2], v[3]),
        i32x4_shuffle::<2, 3, 6, 7>(v[2], v[3]),
    );
    f32x4_pmin(
        i32x4_shuffle::<0, 2, 4, 6>(ab, cd),
        i32x4_shuffle::<1, 3, 5, 7>(ab, cd),
    )
}

/// Lane b of the result is the greatest lane of `v[b]`.
#[inline(always)]
fn maxima(v: [v128; 4]) -> v128 {
    let ab = f32x4_pmax(
        i32x4_shuffle::<0, 1, 4, 5>(v[0], v[1]),
        i32x4_shuffle::<2, 3, 6, 7>(v[0], v[1]),
    );
    let cd = f32x4_pmax(
        i32x4_shuffle::<0, 1, 4, 5>(v[2], v[3]),
        i32x4_shuffle::<2, 3, 6, 7>(v[2], v[3]),
    );
    f32x4_pmax(
        i32x4_shuffle::<0, 2, 4, 6>(ab, cd),
        i32x4_shuffle::<1, 3, 5, 7>(ab, cd),
    )
}

/// Folds a tile level four pairs to one, two output pairs a step. Only for
/// tile levels: `pairs` is a multiple of eight, no value is NaN, which a tree
/// of pmin and pmax needs, and no value is negative zero, so the result needs
/// no zero added. The exported `fold` accepts any input.
#[inline(always)]
unsafe fn fold4(input: *const f32, pairs: usize, output: *mut f32) {
    let mut i = 0;
    while i < pairs {
        let at = unsafe { input.add(2 * i) };
        let [v0, v1, v2, v3] = [0, 4, 8, 12].map(|k| unsafe { v128_load(at.add(k).cast()) });
        // Minima in even lanes, maxima in odd ones.
        let a = i32x4_shuffle::<0, 5, 2, 7>(f32x4_pmin(v0, v1), f32x4_pmax(v0, v1));
        let b = i32x4_shuffle::<0, 5, 2, 7>(f32x4_pmin(v2, v3), f32x4_pmax(v2, v3));
        let s = i32x4_shuffle::<0, 1, 4, 5>(a, b);
        let t = i32x4_shuffle::<2, 3, 6, 7>(a, b);
        let pair = i32x4_shuffle::<0, 5, 2, 7>(f32x4_pmin(s, t), f32x4_pmax(s, t));
        unsafe { v128_store(output.add(i / 2).cast(), pair) };
        i += 8;
    }
}
