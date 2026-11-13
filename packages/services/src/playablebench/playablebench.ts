// PlayableBench 个人工作管理服务接口与 descriptor（纯类型/常量文件）。
// 与实现文件（playablebenchService.ts）分离：descriptor 会被 renderer 经
// @zcode/services 根 index 引入浏览器包，实现文件携带 node:sqlite/node:crypto
// 链，混入会导致 renderer 模块加载黑屏（与 onboarding/onboardingRecord.ts 同惯例）。
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
  ZCodeTaskPriority,
} from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export interface IPlayableBenchService {
  /** 捕获 Inbox 原始输入（逐字保留，PRD-02）。 */
  captureInboxItem(input: InboxCaptureInput): Promise<InboxItem>;
  listInboxItems(params?: { status?: InboxItemStatus; limit?: number }): Promise<InboxItem[]>;
  archiveInboxItem(id: string): Promise<InboxItem | null>;
  /** 把 Inbox 条目转成任务：原始输入保留、失败可重试（spec 02 US-A2 验收）。 */
  convertInboxItemToTask(params: {
    id: string;
    workspacePath: string;
    workspaceIdentity?: string;
    title?: string;
    priority?: ZCodeTaskPriority;
    dueAt?: number;
  }): Promise<InboxConvertToTaskResult>;
  /** Today 聚合（spec 01 §4.1）。 */
  getTodaySummary(params?: { timezoneOffsetMinutes?: number; nowMs?: number }): Promise<TodaySummary>;
  createProject(params: { name: string; description?: string; color?: string }): Promise<Project>;
  listProjects(params?: { status?: ProjectStatus }): Promise<Project[]>;
  updateProject(
    id: string,
    params: { name?: string; description?: string | null; color?: string | null },
  ): Promise<Project | null>;
  archiveProject(id: string): Promise<Project | null>;
  createNote(params: { title?: string; body?: string; projectId?: string }): Promise<Note>;
  listNotes(params?: { projectId?: string; limit?: number }): Promise<Note[]>;
  updateNote(
    id: string,
    params: { title?: string; body?: string; projectId?: string | null },
  ): Promise<Note | null>;
  deleteNote(id: string): Promise<boolean>;
  linkProjectItem(params: { projectId: string; kind: ProjectLinkKind; linkId: string }): Promise<ProjectLink>;
  unlinkProjectItem(params: { projectId: string; kind: ProjectLinkKind; linkId: string }): Promise<boolean>;
  listProjectLinks(params: { projectId?: string; kind?: ProjectLinkKind; linkId?: string }): Promise<ProjectLink[]>;
}

export const IPlayableBenchService = createServiceDescriptor<IPlayableBenchService>(
  ServiceChannels.PlayableBench,
);
