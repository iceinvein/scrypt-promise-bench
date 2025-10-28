# Scrypt Promisify Benchmark

Benchmark and compare Node.js crypto.scrypt across three async styles:
- callback (raw callback API wrapped in a Promise)
- util.promisify(crypto.scrypt)
- manual Promise wrapper (new Promise)

Quantifies:
- Throughput (iterations/sec and calls/sec)
- Latency percentiles per scrypt call (p50, p90, p99)
- Failures (errors or mismatches in sequential validation)

Goal: verify whether util.promisify behaves differently under high concurrency.

## Requirements

- Node.js 18+ (tested on Node 22.12.0)
- macOS/Linux/Windows
- File: scrypt-bench.mjs (ES module)

## Files

- scrypt-bench.mjs — the benchmark runner (ESM)

## Quick Start

Recommended: increase libuv threadpool for CPU-heavy scrypt.

```bash
node --version
UV_THREADPOOL_SIZE=128 node scrypt-bench.mjs
```

Default configuration:
- iterations: 2000
- concurrencies: 1,10,50,100,500,1000
- mode: sequential (each input is run twice and compared)
- scrypt options: N=16384, r=8, p=1, maxmem=32MiB
- keyLen: 64 bytes

The script prints:
- Per-batch summary lines with throughput and latency metrics
- Markdown tables after the run comparing variants per concurrency, with best values marked by an asterisk (*)

## CLI Options

All flags are optional.

Examples:

```bash
# Heavier run with selected concurrencies
UV_THREADPOOL_SIZE=128 node scrypt-bench.mjs --iterations=10000 --concurrency=50,100,500,1000

# Randomized inputs (reproducible via seed), CSV output
node scrypt-bench.mjs --mode=random --seed=42 --csv > results.csv

# Tweak scrypt cost parameters
node scrypt-bench.mjs --N=32768 --r=8 --p=1 --maxmem=67108864
```

Flags:
- --iterations=<int> default 2000
- --concurrency=<csv> default 1,10,50,100,500,1000
- --mode=sequential|random default sequential
  - sequential: each iteration runs two scrypt calls with the same input; outputs must match
  - random: new inputs per call; only counts thrown errors
- --seed=<int> default 1337 (deterministic PRNG for reproducibility)
- --keylen=<int> default 64
- --N=<int> default 16384
- --r=<int> default 8
- --p=<int> default 1
- --maxmem=<int> default 33554432 (bytes, 32 MiB)
- --csv emit CSV rows (no Markdown tables)
- --no-progress suppress per-batch progress logs

## Output

Per-batch human-readable line (one per variant x concurrency), example:

Done: variant=utilPromisify conc=100 ok=2000 fail=0 time=12940ms iter/s=154.53 calls/s=309.06 p50=5.2ms p90=7.1ms p99=10.6ms

- iter/s: iterations per second
- calls/s: scrypt calls per second (in sequential mode there are 2 calls/iteration)
- p50/p90/p99: per-call latency percentiles
- fail: number of errors or mismatches

Markdown summary tables (human mode only) per concurrency:

| Variant       | Fail | Iter/s  | Calls/s | p50 (ms) | p90 (ms) | p99 (ms) | Time (ms) |
|---------------|-----:|--------:|--------:|---------:|---------:|---------:|----------:|
| callback      |    0 | 180.12  | 360.24  | 5.40     | 7.10     | 10.55    | 11037.1   |
| utilPromisify |    0 | 181.00* | 362.00* | 5.38*    | 7.02*    | 10.50*   | 11005.7   |
| manualPromise |    0 | 180.76  | 361.52  | 5.39     | 7.03     | 10.51    | 11015.3   |

Note: * marks the best value in that column (higher is better for Iter/s, Calls/s; lower is better for p50/p90/p99).

CSV mode (--csv) prints one row per batch:

variant,concurrency,iterations,ok,fail,time_ms,iter_throughput_ops_s,call_throughput_calls_s,p50_ms,p90_ms,p99_ms,mode,seed,N,r,p,maxmem,keylen
utilPromisify,100,2000,2000,0,12940.1,154.53,309.06,5.21,7.10,10.55,sequential,1337,16384,8,1,33554432,64

## Interpreting Results

- If util.promisify shows failures while callback and manualPromise do not:
  - Capture sample errors (message/code) from the logs; this suggests a promisify-path issue to investigate further.
- If failures correlate with high concurrencies or disappear after raising UV_THREADPOOL_SIZE:
  - Likely threadpool/resource contention, not promisify.
- If type: "mismatch" appears in sequential mode:
  - Same input produced different output. Common causes:
    - Shared or mutated buffers across tasks
    - Incorrect argument ordering (ensure scrypt(password, salt, keylen, options, callback))
    - Environment/OpenSSL issues

## Tips

- Increase stress:
  - --iterations=10000 (or more)
  - --concurrency=2000,5000 (very heavy)
  - UV_THREADPOOL_SIZE=128 (or 256 on large machines)
- Increase scrypt cost:
  - --N=32768 (or higher), adjust --maxmem accordingly
- Keep explicit options to avoid signature ambiguity:
  - Always call scrypt(password, salt, keylen, options, callback)

## Troubleshooting

Process does not exit:
- The script clears its timeouts; if you still need a hard exit, append the following after the final await:
  setImmediate(() => process.exit(0))

Only “Variant: callback” appears:
- Ensure you are running the latest file; it should log the available variants at start.

Hangs on first batch:
- Reduce workload: --iterations=50 --concurrency=1
- Verify scrypt works via the printed scryptSync sanity check
- Use default cost params before raising them

## Rationale

The benchmark keeps the underlying crypto.scrypt call identical across variants and only changes the Promise wrapping. If util.promisify introduced internal caching or other behavior differences, they would surface in error rates, throughput, or latency distributions under controlled concurrency.

## License

MIT
