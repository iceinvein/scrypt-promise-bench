# Scrypt Promisify Benchmark

Compare Node.js `crypto.scrypt` behavior across:
- callback (raw callback API wrapped in a Promise)
- `util.promisify(crypto.scrypt)`
- manual Promise wrapper (`new Promise`)

Goal: verify claims that `util.promisify` causes failures under high concurrency.

## Requirements

- Node.js 18+ (tested on Node 22.12.0)
- macOS/Linux/Windows
- File: `scrypt-bench.mjs` (ES module)

## Quick Start

Recommended: increase libuv threadpool for CPU-heavy scrypt.

```bash
node --version
UV_THREADPOOL_SIZE=128 node scrypt-bench.mjs
```

By default:
- iterations: `2000`
- concurrencies: `1,10,50,100,500,1000`
- mode: `sequential` (each input is checked twice for determinism)
- scrypt options: `N=16384, r=8, p=1, maxmem=32MiB`
- keyLen: `64` bytes

## CLI Options

All flags optional.

```bash
# Heavier run, selected concurrencies
UV_THREADPOOL_SIZE=128 node scrypt-bench.mjs \
  --iterations=10000 --concurrency=50,100,500,1000

# Randomized inputs (reproducible via seed), CSV output
node scrypt-bench.mjs --mode=random --seed=42 --csv > results.csv

# Tweak scrypt cost parameters
node scrypt-bench.mjs --N=32768 --r=8 --p=1 --maxmem=67108864
```

Flags:
- `--iterations=<int>` default `2000`
- `--concurrency=<csv>` default `1,10,50,100,500,1000`
- `--mode=sequential|random` default `sequential`
  - `sequential`: runs each input twice and verifies outputs match
  - `random`: new inputs per call; only counts thrown errors
- `--seed=<int>` default `1337` (deterministic PRNG for reproducibility)
- `--keylen=<int>` default `64`
- `--N=<int>` default `16384`
- `--r=<int>` default `8`
- `--p=<int>` default `1`
- `--maxmem=<int>` default `33554432` (bytes, 32 MiB)
- `--csv` emit CSV rows instead of human logs
- `--no-progress` suppress per-batch progress logs

## Output

Human-readable:
- Prints a brief scrypt sanity check
- For each variant and concurrency:
  - `Done: variant=... concurrency=... ok=NNN fail=MMM time=XXXXms`
  - On failure, prints sample error objects

CSV (when `--csv` is set), one row per batch:
- Columns: `variant,concurrency,iterations,ok,fail,time_ms,mode,seed,N,r,p,maxmem,keylen`

## Interpreting Results

- If `utilPromisify` shows `fail > 0` while `callback` and `manualPromise` are `0`:
  - Capture the printed “Sample errors” (message/code/stack). That suggests a promisify-path issue worth investigating.
- If failures only occur at high concurrencies or disappear after raising `UV_THREADPOOL_SIZE`:
  - Likely threadpool/resource contention, not `promisify`.
- If `type: "mismatch"` appears in `sequential` mode:
  - Same input produced different output. Common causes:
    - Shared or mutated buffers across tasks
    - Incorrect argument ordering leading to signature ambiguity
    - Environment/OpenSSL issues

## Tips

- Increase stress:
  - Raise `--iterations` (e.g., `10000–50000`)
  - Add higher concurrencies: `--concurrency=2000,5000`
  - Increase threadpool: `UV_THREADPOOL_SIZE=128` (or `256` on beefy machines)
- Increase cost:
  - `--N=32768` (or higher); adjust `--maxmem` accordingly
- Keep explicit options to avoid scrypt signature pitfalls:
  - `scrypt(password, salt, keylen, options, callback)`

## Troubleshooting

Process doesn’t exit
- The script’s timeout helper cancels timers. If you still need a hard exit, append:
  - `setImmediate(() => process.exit(0))` after `await main()`.

Only “Variant: callback” appears
- Ensure you’re running the latest file that logs:
  - `Have variants: [ 'callback', 'utilPromisify', 'manualPromise' ]`

Hangs on first batch
- Reduce workload: `--iterations=50 --concurrency=1`
- Verify scrypt works (script prints `scryptSync` sanity at start)
- Try default cost params before cranking them up.

## Rationale

This benchmark isolates the Promise layer while keeping the actual `crypto.scrypt` call identical. If `util.promisify` introduced caching or other odd behavior, differences should surface under controlled, high-concurrency conditions.

## License

MIT (or adapt to your project’s license)
