// scrypt-bench.mjs
// Quantifies throughput and latency (p50/p90/p99) for callback, util.promisify,
// and manual Promise variants of crypto.scrypt.
//
// CLI flags (all optional):
// --iterations=2000
// --concurrency=1,10,50,100,500,1000
// --mode=sequential|random (default sequential)
// --seed=1337
// --keylen=64
// --N=16384 --r=8 --p=1 --maxmem=33554432
// --csv (emit CSV rows)
// --no-progress
//
// Throughput reported at iteration level and per-call level.
// In sequential mode there are 2 scrypt calls per iteration.

import { scrypt, scryptSync } from "node:crypto";
import { promisify } from "node:util";

// ---------- CLI parsing ----------
const argv = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] === undefined ? true : m[2]] : [a, true];
  })
);

function parseIntsCSV(v, def) {
  if (v == null) return def;
  return String(v)
    .split(",")
    .map((x) => parseInt(x.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0);
}

const iterations = parseInt(argv.iterations ?? "2000", 10);
const concurrencies = parseIntsCSV(argv.concurrency, [1, 10, 50, 100, 500, 1000]);
const keyLen = parseInt(argv.keylen ?? "64", 10);
const mode = (argv.mode ?? "sequential").toLowerCase(); // sequential|random
const csvMode = !!argv.csv;
const progress = !argv["no-progress"];

const opts = {
  N: parseInt(argv.N ?? "16384", 10),
  r: parseInt(argv.r ?? "8", 10),
  p: parseInt(argv.p ?? "1", 10),
  maxmem: parseInt(argv.maxmem ?? String(32 * 1024 * 1024), 10),
};

// ---------- Deterministic PRNG ----------
function mulberry32(seed) {
  let t = seed >>> 0;
  return function () {
    t += 0x6d2b79f5;
    let n = Math.imul(t ^ (t >>> 15), 1 | t);
    n ^= n + Math.imul(n ^ (n >>> 7), 61 | n);
    return ((n ^ (n >>> 14)) >>> 0) / 4294967296;
  };
}

const seed = parseInt(argv.seed ?? "1337", 10);
const rand = mulberry32(seed);

function randBuf(len) {
  const b = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) b[i] = Math.floor(rand() * 256);
  return b;
}

// ---------- Variants ----------
const scryptPromisified = promisify(scrypt);

const variants = {
  callback: (pwd, salt, keyLen, opts) =>
    new Promise((resolve, reject) => {
      scrypt(pwd, salt, keyLen, opts, (err, dk) =>
        err ? reject(err) : resolve(dk)
      );
    }),
  utilPromisify: (pwd, salt, keyLen, opts) =>
    scryptPromisified(pwd, salt, keyLen, opts),
  manualPromise: (pwd, salt, keyLen, opts) =>
    new Promise((resolve, reject) => {
      scrypt(pwd, salt, keyLen, opts, (err, dk) =>
        err ? reject(err) : resolve(dk)
      );
    }),
};

// ---------- Helpers ----------
const range = (n) => Array.from({ length: n }, (_, i) => i);

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, rej) => {
    timer = setTimeout(
      () => rej(new Error(`timeout after ${ms}ms: ${label}`)),
      ms
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function percentile(sorted, p) {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)
  );
  return sorted[idx];
}

async function runBatch({ variant, concurrency, iterations, keyLen, opts }) {
  const mkInput = (i) => {
    if (mode === "random") {
      return {
        pwd: randBuf(16 + (i % 16)),
        salt: randBuf(16 + ((i * 7) % 16)),
      };
    }
    return {
      pwd: Buffer.from(`pwd-${i}`),
      salt: Buffer.from(`salt-${i}`),
    };
  };

  const runOnce = async (i) => {
    const { pwd, salt } = mkInput(i);
    const t0 = performance.now();
    const dk = await withTimeout(
      variants[variant](pwd, salt, keyLen, opts),
      60000,
      `${variant} i=${i}`
    );
    const t1 = performance.now();
    return { dk, ms: t1 - t0 };
  };

  let ok = 0;
  let fail = 0;
  const errors = [];
  const callDurations = []; // per scrypt call
  const tStart = performance.now();

  const queue = range(iterations);
  const logEvery = Math.max(1, Math.floor(iterations / 10));

  const workers = range(concurrency).map(async (_, w) => {
    while (queue.length) {
      const i = queue.pop();
      if (progress && i % logEvery === 0) {
        console.log(`[${variant}] w${w} progress i=${i}`);
      }
      try {
        const a = await runOnce(i);
        callDurations.push(a.ms);
        if (mode === "sequential") {
          const b = await runOnce(i);
          callDurations.push(b.ms);
          if (!a.dk.equals(b.dk)) {
            fail++;
            errors.push({
              type: "mismatch",
              i,
              a: a.dk.toString("hex").slice(0, 16),
              b: b.dk.toString("hex").slice(0, 16),
            });
            continue;
          }
        }
        ok++;
      } catch (e) {
        fail++;
        errors.push({
          type: "error",
          i,
          msg: e?.message,
          code: e?.code,
        });
      }
    }
  });

  await Promise.all(workers);
  const tEnd = performance.now();

  // Metrics
  const totalMs = tEnd - tStart;
  const callsPerIter = mode === "sequential" ? 2 : 1;
  const totalCalls = ok * callsPerIter + fail * callsPerIter; // approx if failures early
  const iterThroughput = (ok / (totalMs / 1000));
  const callThroughput = (totalCalls / (totalMs / 1000));

  const sorted = callDurations.slice().sort((a, b) => a - b);
  const p50 = percentile(sorted, 50);
  const p90 = percentile(sorted, 90);
  const p99 = percentile(sorted, 99);

  return {
    variant,
    concurrency,
    iterations,
    ok,
    fail,
    totalMs,
    iterThroughput,
    callThroughput,
    p50,
    p90,
    p99,
    errors,
  };
}

// ---------- Main ----------
async function main() {
  console.log(
    `scrypt sanity: typeof=${typeof scrypt} sync=${scryptSync("a", "b", 8)
      .toString("hex")
      .slice(0, 8)}`
  );
  console.log(
    `config: iterations=${iterations} concurrencies=[${concurrencies.join(
      ","
    )}] keyLen=${keyLen} mode=${mode} seed=${seed} opts=${JSON.stringify(
      opts
    )}`
  );

  if (csvMode) {
    console.log(
      [
        "variant",
        "concurrency",
        "iterations",
        "ok",
        "fail",
        "time_ms",
        "iter_throughput_ops_s",
        "call_throughput_calls_s",
        "p50_ms",
        "p90_ms",
        "p99_ms",
        "mode",
        "seed",
        "N",
        "r",
        "p",
        "maxmem",
        "keylen",
      ].join(",")
    );
  }

  const order = ["callback", "utilPromisify", "manualPromise"];
  const allResults = [];

  for (const variant of order) {
    if (!csvMode) console.log(`\nVariant: ${variant}`);
    for (const c of concurrencies) {
      if (!csvMode)
        console.log(`Starting batch: variant=${variant} concurrency=${c}`);

      const r = await runBatch({
        variant,
        concurrency: c,
        iterations,
        keyLen,
        opts,
      });

      allResults.push(r);

      if (csvMode) {
        console.log(
          [
            r.variant,
            c,
            r.iterations,
            r.ok,
            r.fail,
            r.totalMs.toFixed(1),
            r.iterThroughput.toFixed(2),
            r.callThroughput.toFixed(2),
            r.p50?.toFixed(2) ?? "",
            r.p90?.toFixed(2) ?? "",
            r.p99?.toFixed(2) ?? "",
            mode,
            seed,
            opts.N,
            opts.r,
            opts.p,
            opts.maxmem,
            keyLen,
          ].join(",")
        );
      } else {
        console.log(
          `Done: variant=${r.variant} conc=${r.concurrency} ` +
            `ok=${r.ok} fail=${r.fail} time=${r.totalMs.toFixed(0)}ms ` +
            `iter/s=${r.iterThroughput.toFixed(2)} calls/s=${r.callThroughput.toFixed(
              2
            )} p50=${r.p50?.toFixed(1)}ms p90=${r.p90?.toFixed(
              1
            )}ms p99=${r.p99?.toFixed(1)}ms`
        );
        if (r.fail) {
          console.log("Sample errors:", r.errors.slice(0, 5));
        }
      }
    }
  }

  if (!csvMode) {
    // Render Markdown comparison tables
    function mdEscape(s) {
      return String(s).replace(/\|/g, "\\|");
    }
    function byConc(conc) {
      return allResults.filter((r) => r.concurrency === conc);
    }
    function best(results, key, higherIsBetter = true) {
      const vals = results.map((r) => r[key]).filter(Number.isFinite);
      if (!vals.length) return null;
      const bestVal = higherIsBetter
        ? Math.max(...vals)
        : Math.min(...vals);
      return { bestVal, set: new Set(results.filter((r) => r[key] === bestVal).map((r) => r.variant)) };
    }
    function row(r, bests) {
      const v = r.variant;
      const fmt = (x, d = 2) =>
        Number.isFinite(x) ? Number(x).toFixed(d) : "";
      const star = (metric, text) =>
        bests[metric].set.has(v) ? `${text} *` : text;

      return [
        mdEscape(v),
        r.fail,
        star("iterThroughput", fmt(r.iterThroughput)),
        star("callThroughput", fmt(r.callThroughput)),
        star("p50", fmt(r.p50)),
        star("p90", fmt(r.p90)),
        star("p99", fmt(r.p99)),
        fmt(r.totalMs, 1),
      ].join(" | ");
    }

    console.log("\n=== Markdown Summary Tables ===");
    for (const conc of concurrencies) {
      const rs = byConc(conc);
      if (!rs.length) continue;

      const bests = {
        iterThroughput: best(rs, "iterThroughput", true),
        callThroughput: best(rs, "callThroughput", true),
        p50: best(rs, "p50", false),
        p90: best(rs, "p90", false),
        p99: best(rs, "p99", false),
      };

      console.log(`\nConcurrency ${conc}`);
      console.log(
        [
          "| Variant | Fail | Iter/s | Calls/s | p50 (ms) | p90 (ms) | p99 (ms) | Time (ms) |",
          "|--------|-----:|-------:|--------:|---------:|---------:|---------:|----------:|",
          ...rs.map((r) => `| ${row(r, bests)} |`),
        ].join("\n")
      );
      console.log(
        "\nNotes: * marks the best value per column (higher is better for Iter/s, Calls/s; lower is better for p50/p90/p99)."
      );
    }
  }

  if (!csvMode) console.log("\nBenchmark complete.");
}

await main();
