// scrypt-bench.mjs
// Node 18+ ES module. Benchmark crypto.scrypt via callback, util.promisify,
// and manual Promise. Adds deterministic PRNG, random/sequential modes,
// CSV output, and CLI flags.
//
// CLI flags (all optional):
// --iterations=2000
// --concurrency=1,10,50,100,500,1000
// --mode=sequential|random
// --seed=12345
// --keylen=64
// --N=16384 --r=8 --p=1 --maxmem=33554432
// --csv (emit CSV rows)
// --no-progress (suppress per-batch progress logs)

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

async function runBatch({ variant, concurrency, iterations, keyLen, opts }) {
  const mkInput = (i) => {
    if (mode === "random") {
      return {
        pwd: randBuf(16 + (i % 16)),
        salt: randBuf(16 + ((i * 7) % 16)),
      };
    }
    // sequential mode: deterministic unique per i
    return {
      pwd: Buffer.from(`pwd-${i}`),
      salt: Buffer.from(`salt-${i}`),
    };
  };

  const runOnce = (i) => {
    const { pwd, salt } = mkInput(i);
    return variants[variant](pwd, salt, keyLen, opts);
  };

  let ok = 0;
  let fail = 0;
  const errors = [];
  const start = Date.now();

  const queue = range(iterations);
  const logEvery = Math.max(1, Math.floor(iterations / 10));

  const workers = range(concurrency).map(async (_, w) => {
    while (queue.length) {
      const i = queue.pop();
      if (progress && i % logEvery === 0) {
        console.log(`[${variant}] w${w} progress i=${i}`);
      }
      try {
        const dk1 = await withTimeout(runOnce(i), 60000, `${variant} i=${i} #1`);
        if (mode === "sequential") {
          const dk2 = await withTimeout(
            runOnce(i),
            60000,
            `${variant} i=${i} #2`
          );
          if (!dk1.equals(dk2)) {
            fail++;
            errors.push({
              type: "mismatch",
              i,
              a: dk1.toString("hex").slice(0, 16),
              b: dk2.toString("hex").slice(0, 16),
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
  const ms = Date.now() - start;
  return { variant, concurrency, iterations, ok, fail, ms, errors };
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
      "variant,concurrency,iterations,ok,fail,time_ms,mode,seed,N,r,p,maxmem,keylen"
    );
  }

  const order = ["callback", "utilPromisify", "manualPromise"];

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
      if (csvMode) {
        console.log(
          [
            variant,
            c,
            r.iterations,
            r.ok,
            r.fail,
            r.ms,
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
          `Done: variant=${variant} concurrency=${c} ok=${r.ok} fail=${r.fail} time=${r.ms}ms`
        );
        if (r.fail) {
          console.log("Sample errors:", r.errors.slice(0, 5));
        }
      }
    }
  }

  if (!csvMode) console.log("Benchmark complete.");
}

await main();
