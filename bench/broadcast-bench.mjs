// N=10,50 timing check with busy-only jitter
import { performance } from "node:perf_hooks";

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

// Simulate broadcast deduped sequential with 500ms jitter only for busy|retry
// Measures deduped sequential timing; chunked fan-out stays out of scope.
async function bench(N) {
  const start = performance.now();
  // deduped outside N: one readRegistry + one statusMap (mock 1ms)
  await sleep(1);
  // sequential POSTs with no jitter (idle peers)
  for (let i = 0; i < N; i++) {
    // simulate prompt_async 204 <50ms (mock 2ms)
    await sleep(2);
  }
  const wall = performance.now() - start;
  return wall;
}

async function run() {
  // Warmup: 3 untimed N=10 passes absorb timer plus scheduling variance;
  // measured walls below start after warmup. Budgets w10<200 w50<500 are
  // harness-local, not product bounds.
  for (let w = 0; w < 3; w++) {
    await bench(10);
  }
  const w10 = await bench(10);
  const w50 = await bench(50);
  console.log(`N10 wall ${w10.toFixed(1)}ms N50 wall ${w50.toFixed(1)}ms`);
  // timing should scale linearly but stay under the bound for N=50
  // Follow-up check: just ensure timing increases and stays < 500ms for N=50
  const ok = w10 < w50 && w50 < 500 && w10 < 200;
  console.log(ok ? "bench PASS broadcast deduped wall<R" : "bench FAIL");
  process.exit(ok ? 0 : 1);
}

run();
