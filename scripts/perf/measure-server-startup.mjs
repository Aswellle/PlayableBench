// 只读性能测量脚本（spec 12 §6 场景 1/2 的 server 形态部分）：
// 1) 冷/热启动：spawn packages/server/dist/entry-http.js，测量进程启动到
//    /api/server-info 返回 200 的耗时（多次采样）。
// 2) 空闲内存：保持一个实例空闲 120s 后采样进程树 RSS。
// 前置：pnpm --filter @zcode/server build；桌面 GUI 启动被本机网络环境阻断
// （WP1 审计发现 B4），桌面形态的启动/空闲内存按受阻如实记录。
// 运行：node scripts/perf/measure-server-startup.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_ENTRY = fileURLToPath(new URL("../../packages/server/dist/entry-http.js", import.meta.url));
const RUNS = Number(process.env.PERF_RUNS ?? 5);
const IDLE_MS = Number(process.env.PERF_IDLE_MS ?? 120_000);
const PROBE_URL = "http://127.0.0.1:3030/api/server-info";

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function killTree(pid) {
  if (!pid) return;
  try {
    const { execFileSync } = await import("node:child_process");
    execFileSync("taskkill", ["/T", "/F", "/PID", String(pid)], { stdio: "ignore" });
  } catch {}
}

async function waitForPortFree(deadlineMs = 10_000) {
  const deadline = performance.now() + deadlineMs;
  while (performance.now() < deadline) {
    try {
      await fetch(PROBE_URL, { signal: AbortSignal.timeout(800) });
      // 仍能连通说明上一个实例还活着，继续等待。
    } catch {
      return;
    }
    await wait(100);
  }
}

async function probeOnce() {
  const started = performance.now();
  try {
    const response = await fetch(PROBE_URL, { signal: AbortSignal.timeout(1500) });
    if (response.status === 200) {
      return performance.now() - started;
    }
    return null;
  } catch {
    return null;
  }
}

async function waitForReady(deadlineMs) {
  const deadline = performance.now() + deadlineMs;
  while (performance.now() < deadline) {
    const elapsed = await probeOnce();
    if (elapsed !== null) {
      return elapsed;
    }
    await wait(50);
  }
  return null;
}

async function measureOneRun(index, dataDir, options) {
  const spawnedAt = performance.now();
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    env: { ...process.env, ZCODE_DATA_BASE_DIR: dataDir },
    stdio: "ignore",
    detached: false,
  });
  const readyElapsed = await waitForReady(options?.readyTimeoutMs ?? 30_000);
  if (readyElapsed === null) {
    await killTree(child.pid);
    await waitForPortFree();
    return { index, ok: false, reason: "not-ready-within-timeout" };
  }
  return {
    index,
    ok: true,
    // 从 spawn 到首个 200 的总耗时（含 node 启动），即"启动至可服务"。
    startupMs: Math.round(performance.now() - spawnedAt),
    // fetch 路径自身耗时（服务就绪后的请求 RTT），用于拆分噪声。
    probeMs: Math.round(readyElapsed),
    pid: child.pid,
    keepAlive: options?.keepAlive === true,
  };
}

async function sampleTreeRss(rootPid) {
  const { execFileSync } = await import("node:child_process");
  const output = execFileSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      `$ids=@();$q=Get-CimInstance Win32_Process -Filter "ParentProcessId=${rootPid}" | Select-Object -ExpandProperty ProcessId;$ids+=$q;foreach($p in $q){$ids+=(Get-CimInstance Win32_Process -Filter "ParentProcessId=$p" | Select-Object -ExpandProperty ProcessId)};$ids+=$ids.Count;($ids | Select-Object -Unique) -join ','`,
    ],
    { encoding: "utf8" },
  ).trim();
  const pids = output
    .split(",")
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0);
  pids.push(rootPid);
  const unique = [...new Set(pids)];
  const lines = execFileSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      `Get-Process -Id ${unique.join(",")} -ErrorAction SilentlyContinue | Select-Object Id,WorkingSet64 | ConvertTo-Json -Compress`,
    ],
    { encoding: "utf8" },
  ).trim();
  let entries = JSON.parse(lines);
  if (!Array.isArray(entries)) entries = [entries];
  const totalRssMb = entries.reduce((sum, entry) => sum + entry.WorkingSet64 / 1024 / 1024, 0);
  return { pids: unique.length, rssMb: Number(totalRssMb.toFixed(1)) };
}

async function main() {
  const startupSamples = [];
  let idleSample;
  const dataDirs = [];
  try {
    for (let index = 1; index <= RUNS; index += 1) {
      const dataDir = mkdtempSync(join(tmpdir(), "zcode-perf-server-"));
      dataDirs.push(dataDir);
      const result = await measureOneRun(index, dataDir);
      startupSamples.push(result);
      process.stdout.write(`run ${index}: ${JSON.stringify(result)}\n`);
      if (result.ok) {
        // Windows 上 child.kill() 只杀父进程，server 可能残留持有 3030 的子进程；
        // 杀整树并等端口释放，保证下一轮是真冷启动。
        await killTree(result.pid);
        await waitForPortFree();
      }
    }

    // 空闲内存：新起一个实例，保持 IDLE_MS 后采样进程树 RSS。
    const dataDir = mkdtempSync(join(tmpdir(), "zcode-perf-server-idle-"));
    dataDirs.push(dataDir);
    const idle = await measureOneRun(0, dataDir, { keepAlive: true });
    if (idle.ok && idle.pid) {
      process.stdout.write(`idling ${IDLE_MS}ms with pid=${idle.pid}\n`);
      await wait(IDLE_MS);
      idleSample = { ...(await sampleTreeRss(idle.pid)), startupMs: idle.startupMs };
      process.stdout.write(`idle sample: ${JSON.stringify(idleSample)}\n`);
    }
    try {
      if (idle.pid) await killTree(idle.pid);
    } catch {}
    await waitForPortFree();

    const okRuns = startupSamples.filter((entry) => entry.ok);
    const sorted = okRuns.map((entry) => entry.startupMs).sort((a, b) => a - b);
    const pick = (p) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
    console.log(
      JSON.stringify(
        {
          runs: RUNS,
          okRuns: okRuns.length,
          node: process.version,
          startupMs: {
            min: sorted[0],
            p50: pick(50),
            p95: pick(95),
            max: sorted[sorted.length - 1],
          },
          samples: startupSamples,
          idleAfterMs: IDLE_MS,
          idleSample,
        },
        null,
        2,
      ),
    );
  } finally {
    for (const dir of dataDirs) {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
      } catch (error) {
        // 临时目录残留交给系统清理；不因清理失败影响测量结果输出。
        process.stdout.write(`cleanup skipped for ${dir}: ${String(error)}\n`);
      }
    }
  }
}

void main();
