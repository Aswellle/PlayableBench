// PlayableBench 个人工作管理领域类型（spec 06 §2、spec 01 §4.1/4.2）。
// Inbox：原始输入永不丢失（PRD-02）；Projects/Notes：项目上下文聚合（PRD-03 关联）。
// Today：跨域聚合摘要（逾期/今日/高优任务 + 未处理捕获 + 最近记录）。
import type { ZCodeTaskMeta } from "./zcode-task-types-core.js";

export type InboxItemKind = "text" | "url" | "note";

export type InboxItemStatus = "unprocessed" | "processed" | "archived" | "failed";

export interface InboxItem {
  id: string;
  kind: InboxItemKind;
  /** 用户原始输入，逐字保留；处理失败也不得改写或丢弃（PRD-02 验收）。 */
  rawInput: string;
  title?: string;
  sourceUrl?: string;
  status: InboxItemStatus;
  processingError?: string;
  /** 转任务成功后的关联 taskId。 */
  taskId?: string;
  createdAt: number;
  updatedAt: number;
  processedAt?: number;
}

export interface InboxCaptureInput {
  kind: InboxItemKind;
  rawInput: string;
  title?: string;
  sourceUrl?: string;
}

export interface InboxConvertToTaskResult {
  inboxItemId: string;
  /** 转出的任务完整 meta（经 tasks-index 持久化）。 */
  task: ZCodeTaskMeta;
}

export type ProjectStatus = "active" | "archived";

export interface Project {
  id: string;
  name: string;
  description?: string;
  color?: string;
  status: ProjectStatus;
  archivedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface Note {
  id: string;
  title: string;
  body: string;
  projectId?: string;
  createdAt: number;
  updatedAt: number;
}

/** project_links 的关联种类；task 关联指向 tasks-index 的 task_id，feed_item 关联指向 pb_feed_items.id。 */
export type ProjectLinkKind = "task" | "note" | "inbox_item" | "feed_item";

export interface ProjectLink {
  projectId: string;
  kind: ProjectLinkKind;
  linkId: string;
  createdAt: number;
}

/** Today 聚合（spec 01 §4.1）：全部来自 tasks-index 持久化事实，不推断运行时状态。 */
export interface TodaySummary {
  /** dueAt 已过且未完成的任务（逾期）。 */
  overdueTasks: ZCodeTaskMeta[];
  /** 今日结束前到期的任务。 */
  dueTodayTasks: ZCodeTaskMeta[];
  /** high/urgent 优先级的未完成任务。 */
  highPriorityTasks: ZCodeTaskMeta[];
  /** 最近保存的未处理 Inbox 条目（最多 10 条）。 */
  recentInboxItems: InboxItem[];
  /** 各分段数量，便于空态/角标渲染。 */
  counts: {
    overdue: number;
    dueToday: number;
    highPriority: number;
    unprocessedInbox: number;
  };
  generatedAt: number;
  timezoneOffsetMinutes: number;
}
