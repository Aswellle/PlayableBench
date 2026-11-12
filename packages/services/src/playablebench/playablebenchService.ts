// PlayableBench 个人工作管理服务实现（Phase 2 切片 3a）。
// 接口与 descriptor 在 playablebench.ts（纯文件，renderer 可安全引入）；
// 本文件只在 host/node 侧加载（node:sqlite / node:crypto 依赖链）。
import { randomUUID } from "node:crypto";
import type {
  InboxCaptureInput,
  InboxConvertToTaskResult,
  InboxItem,
  InboxItemStatus,
  Note,
  Project,
  ProjectLink,
  ProjectLinkKind,
  ProjectStatus,
  TodaySummary,
  ZCodeTaskMeta,
  ZCodeTaskPriority,
} from "@zcode/shared";
import { InboxRepo } from "../session/inboxRepo.js";
import { ProjectsRepo } from "../session/projectsRepo.js";
import { TaskIndexRepo } from "../session/taskIndexRepo.js";
import { IPlayableBenchService } from "./playablebench.js";

// 同名再导出（类型 + descriptor 常量）；host/node 侧使用。
export { IPlayableBenchService };

export interface CreatePlayableBenchServiceOptions {
  /** 依赖注入便于测试；缺省用进程默认 tasks-index 路径（与 AutomationRepo 同策略）。 */
  inboxRepo?: InboxRepo;
  projectsRepo?: ProjectsRepo;
  taskIndexRepo?: TaskIndexRepo;
}

export function createPlayableBenchService(
  options: CreatePlayableBenchServiceOptions = {},
): IPlayableBenchService {
  const inboxRepo = options.inboxRepo ?? new InboxRepo();
  const projectsRepo = options.projectsRepo ?? new ProjectsRepo();
  const taskIndexRepo = options.taskIndexRepo ?? new TaskIndexRepo();

  return {
    async captureInboxItem(input: InboxCaptureInput): Promise<InboxItem> {
      return inboxRepo.capture(input);
    },

    async listInboxItems(params?: {
      status?: InboxItemStatus;
      limit?: number;
    }): Promise<InboxItem[]> {
      return inboxRepo.list(params);
    },

    async archiveInboxItem(id: string): Promise<InboxItem | null> {
      return inboxRepo.archive(id);
    },

    async convertInboxItemToTask(params: {
      id: string;
      workspacePath: string;
      workspaceIdentity?: string;
      title?: string;
      priority?: ZCodeTaskPriority;
      dueAt?: number;
    }): Promise<InboxConvertToTaskResult> {
      const item = await inboxRepo.get(params.id);
      if (!item) {
        throw new Error(`Inbox 条目不存在: ${params.id}`);
      }
      // 标题优先取用户整理时的输入，其次条目 title，最后原始输入首行；截断防超长。
      const rawFirstLine = item.rawInput.trim().split(/\r?\n/)[0] ?? item.rawInput.trim();
      const title = (params.title?.trim() || item.title?.trim() || rawFirstLine).slice(0, 200);
      const now = Date.now();
      let task: ZCodeTaskMeta;
      try {
        task = await taskIndexRepo.seedTaskMetaIfMissing({
          taskId: `task-${randomUUID()}`,
          traceId: `trace-${randomUUID()}`,
          title,
          workspacePath: params.workspacePath,
          ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
          createdAt: now,
          updatedAt: now,
          mode: "default",
          priority: params.priority,
          dueAt: params.dueAt,
        });
      } catch (error) {
        // 转任务失败：保留原始输入并记录原因（PRD-02 验收：失败不丢内容，可重试）。
        await inboxRepo.markFailed(params.id, error instanceof Error ? error.message : String(error));
        throw error;
      }
      const processed = await inboxRepo.markProcessed(params.id, task.taskId);
      if (!processed) {
        throw new Error(`Inbox 条目转任务后状态更新失败: ${params.id}`);
      }
      return { inboxItemId: params.id, task };
    },

    async getTodaySummary(params?: {
      timezoneOffsetMinutes?: number;
      nowMs?: number;
    }): Promise<TodaySummary> {
      return taskIndexRepo.queryTodaySummary(params);
    },

    async createProject(params: { name: string; description?: string; color?: string }): Promise<Project> {
      return projectsRepo.createProject(params);
    },

    async listProjects(params?: { status?: ProjectStatus }): Promise<Project[]> {
      return projectsRepo.listProjects(params);
    },

    async updateProject(
      id: string,
      params: { name?: string; description?: string | null; color?: string | null },
    ): Promise<Project | null> {
      return projectsRepo.updateProject(id, params);
    },

    async archiveProject(id: string): Promise<Project | null> {
      return projectsRepo.archiveProject(id);
    },

    async createNote(params: { title?: string; body?: string; projectId?: string }): Promise<Note> {
      return projectsRepo.createNote(params);
    },

    async listNotes(params?: { projectId?: string; limit?: number }): Promise<Note[]> {
      return projectsRepo.listNotes(params);
    },

    async updateNote(
      id: string,
      params: { title?: string; body?: string; projectId?: string | null },
    ): Promise<Note | null> {
      return projectsRepo.updateNote(id, params);
    },

    async deleteNote(id: string): Promise<boolean> {
      return projectsRepo.deleteNote(id);
    },

    async linkProjectItem(params: {
      projectId: string;
      kind: ProjectLinkKind;
      linkId: string;
    }): Promise<ProjectLink> {
      return projectsRepo.link(params);
    },

    async unlinkProjectItem(params: {
      projectId: string;
      kind: ProjectLinkKind;
      linkId: string;
    }): Promise<boolean> {
      return projectsRepo.unlink(params);
    },

    async listProjectLinks(params: {
      projectId?: string;
      kind?: ProjectLinkKind;
      linkId?: string;
    }): Promise<ProjectLink[]> {
      return projectsRepo.listLinks(params);
    },
  };
}
