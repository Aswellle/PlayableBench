// 只读性能测量脚本（安全审计/性能基线 PF-01）：
// 以真实 TaskIndexRepo.queryTaskList 路径为基准，量化 tasks-index 在 1k 任务
// 规模下 LIKE 全表扫描的查询成本，作为 FTS5 决策的前后对比锚点。
// 运行：npx tsx scripts/perf/measure-tasks-query.ts
// 输出：JSON（每次查询形态的 p50/p95/max，单位 ms）。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { TaskIndexRepo } from "../../packages/services/src/session/taskIndexRepo.js";

const TASK_COUNT = Number(process.env.PERF_TASK_COUNT ?? 1000);
const SAMPLES = Number(process.env.PERF_SAMPLES ?? 30);
const WORKSPACE_PATH = "D:\\perf\\workspace";

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "zcode-perf-tasks-"));
  const dbPath = join(dir, "tasks-index.sqlite");
  const repo = new TaskIndexRepo(dbPath);
  try {
    await repo.ensureReady();

    const base = Date.now() - TASK_COUNT * 1000;
    for (let i = 0; i < TASK_COUNT; i += 1) {
      const needleTitle = i % 50 === 0;
      await repo.seedTaskMetaIfMissing({
        taskId: `task-${String(i).padStart(5, "0")}`,
        traceId: `perf-trace-${i}` as never,
        title: needleTitle
          ? `Deploy pipeline run ${i} with error boundary retry`
          : `Task ${i}: refactor module boundary ${i % 13}`,
        workspacePath: WORKSPACE_PATH,
        createdAt: base + i * 1000,
        updatedAt: base + i * 1000 + 500,
        mode: "default",
      });
    }

    // 用独立连接回填 searchable_text（模拟已索引的会话正文摘要）；
    // 每 10 行注入一次搜索词，覆盖命中与未命中两种扫描路径。
    const filler =
      "讨论了模块边界、回滚策略与发布窗口；附带依赖升级与测试计划，正文长度用于模拟真实会话摘要的扫描成本。";
    const fill = new DatabaseSync(dbPath);
    const updates = fill.prepare("SELECT task_id FROM tasks");
    const setText = fill.prepare("UPDATE tasks SET searchable_text = ? WHERE task_id = ?");
    for (const row of updates.all() as Array<{ task_id: string }>) {
      const index = Number(row.task_id.split("-")[1]);
      const body = index % 10 === 0 ? `处理 error boundary retry 时发现循环依赖 ${filler.repeat(6)}` : filler.repeat(6);
      setText.run(body, row.task_id);
    }
    fill.close();

    const scopes = [{ workspacePath: WORKSPACE_PATH }];
    const scenarios = [
      { name: "search-hit", query: { kind: "timeline", sortBy: "updated", search: "error boundary", workspaceScopes: scopes, limit: 200 } },
      { name: "search-miss", query: { kind: "timeline", sortBy: "updated", search: "zzz-no-such-token", workspaceScopes: scopes, limit: 200 } },
      { name: "list-no-search", query: { kind: "timeline", sortBy: "updated", workspaceScopes: scopes, limit: 200 } },
    ] as const;

    // 预热，排除首次打开/预编译的噪声。
    for (const scenario of scenarios) {
      await repo.queryTaskList({ ...scenario.query });
    }

    const report: Record<string, { p50: number; p95: number; max: number; total: number; samples: number }> = {};
    for (const scenario of scenarios) {
      const durations: number[] = [];
      let total = 0;
      for (let i = 0; i < SAMPLES; i += 1) {
        const started = performance.now();
        const result = await repo.queryTaskList({ ...scenario.query });
        durations.push(performance.now() - started);
        total = result.total;
      }
      durations.sort((a, b) => a - b);
      report[scenario.name] = {
        p50: Number(percentile(durations, 50).toFixed(2)),
        p95: Number(percentile(durations, 95).toFixed(2)),
        max: Number(durations[durations.length - 1].toFixed(2)),
        total,
        samples: SAMPLES,
      };
    }

    console.log(
      JSON.stringify(
        {
          taskCount: TASK_COUNT,
          samples: SAMPLES,
          node: process.version,
          results: report,
        },
        null,
        2,
      ),
    );
  } finally {
    repo.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

void main();
