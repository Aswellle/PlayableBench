// PlayableBenchService 全链路测试（Phase 2 切片 3a）：捕获→列表→转任务→Today 聚合，
// 以及失败路径（taskIndexRepo 抛错时原始输入保留、状态转 failed）。
// 服务必须注入临时库路径的 repos：默认路径会写真实用户库 ~/.zcode/v2（AutomationRepo
// 注释记录过的历史事故同款），测试一律走 makeDbPath 注入。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPlayableBenchService } from "#src/playablebench/playablebenchService.js";
import { InboxRepo } from "#src/session/inboxRepo.js";
import { ProjectsRepo } from "#src/session/projectsRepo.js";
import { TaskIndexRepo } from "#src/session/taskIndexRepo.js";

const tempDirs: string[] = [];

function makeDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "zcode-playablebench-service-"));
  tempDirs.push(dir);
  return join(dir, "tasks-index.sqlite");
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch {
        // Windows 句柄释放延迟；交给系统清理。
      }
    }
  }
});

describe("createPlayableBenchService", () => {
  it("捕获→列表→转任务→Today 聚合 全链路", async () => {
    const dbPath = makeDbPath();
    const service = createPlayableBenchService({
      inboxRepo: new InboxRepo(dbPath),
      projectsRepo: new ProjectsRepo(dbPath),
      taskIndexRepo: new TaskIndexRepo(dbPath),
    });

    const captured = await service.captureInboxItem({
      kind: "url",
      rawInput: "https://example.com/article 关于错误边界处理的讨论",
      title: "错误边界文章",
      sourceUrl: "https://example.com/article",
    });
    expect(captured.status).toBe("unprocessed");

    const items = await service.listInboxItems({ status: "unprocessed" });
    expect(items).toHaveLength(1);

    const converted = await service.convertInboxItemToTask({
      id: captured.id,
      workspacePath: "/tmp/ws-svc",
      title: "研究错误边界处理",
      priority: "high",
    });
    expect(converted.task.title).toBe("研究错误边界处理");
    expect(converted.task.priority).toBe("high");
    const itemAfter = await service.listInboxItems({ status: "processed" });
    expect(itemAfter[0]?.taskId).toBe(converted.task.taskId);
    expect(itemAfter[0]?.rawInput).toContain("https://example.com/article");

    const summary = await service.getTodaySummary();
    expect(summary.counts.unprocessedInbox).toBe(0);
    expect(summary.highPriorityTasks.map((entry) => entry.taskId)).toEqual([
      converted.task.taskId,
    ]);
    expect(summary.highPriorityTasks[0]?.title).toBe("研究错误边界处理");

    const project = await service.createProject({ name: "底座改造" });
    await service.linkProjectItem({ projectId: project.id, kind: "task", linkId: converted.task.taskId });
    const links = await service.listProjectLinks({ projectId: project.id });
    expect(links).toHaveLength(1);
    const notes = await service.listNotes({ projectId: project.id });
    expect(notes).toHaveLength(0);
    const note = await service.createNote({ title: "记录", body: "内容", projectId: project.id });
    expect(note.projectId).toBe(project.id);
    expect((await service.listNotes({ projectId: project.id })).length).toBe(1);
    await expect(
      service.convertInboxItemToTask({ id: "inbox-missing", workspacePath: "/tmp/ws" }),
    ).rejects.toThrow(/不存在/);
  });

  it("转任务失败时保留原始输入并记录失败原因", async () => {
    const dbPath = makeDbPath();
    // 用 stub 让 seedTaskMetaIfMissing 抛错，驱动真实失败路径（标记 failed、保留原文）。
    const failingTaskIndexRepo = Object.create(TaskIndexRepo.prototype) as TaskIndexRepo;
    Object.assign(failingTaskIndexRepo, {
      ensureReady: async () => {},
      seedTaskMetaIfMissing: async () => {
        throw new Error("模拟任务创建失败");
      },
    });
    const service = createPlayableBenchService({
      inboxRepo: new InboxRepo(dbPath),
      projectsRepo: new ProjectsRepo(dbPath),
      taskIndexRepo: failingTaskIndexRepo,
    });

    const captured = await service.captureInboxItem({ kind: "text", rawInput: "会失败的输入" });
    await expect(
      service.convertInboxItemToTask({ id: captured.id, workspacePath: "/tmp/ws" }),
    ).rejects.toThrow(/模拟任务创建失败/);
    const failed = await service.listInboxItems({ status: "failed" });
    expect(failed.map((item) => item.id)).toContain(captured.id);
    const failedItem = failed.find((item) => item.id === captured.id);
    expect(failedItem?.rawInput).toBe("会失败的输入");
    expect(failedItem?.processingError).toContain("模拟任务创建失败");
  });
});
