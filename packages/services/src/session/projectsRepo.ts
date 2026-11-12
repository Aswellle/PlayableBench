// PlayableBench Projects/Notes 关系存储（spec 01 §4.3、PRD-03）：
// projects 承载名字/状态；notes 为最小版内联文本知识条目；project_links 把
// task / note / inbox_item 关联进项目（解绑不删除对象本身，spec 02 US-A3）。
// 同一 tasks-index.sqlite；打开时未迁移会走同一幂等迁移 runner。
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  Note,
  Project,
  ProjectLink,
  ProjectLinkKind,
  ProjectStatus,
} from "@zcode/shared";
import { getTasksIndexDatabasePath } from "#src/paths.js";
import { runTasksDatabaseMigrations } from "#src/session/tasksDatabase/migrations.js";
import { isTasksStoragePrepared } from "#src/session/tasksDatabase/prepared.js";
import { PLAYABLEBENCH_FTS_REBUILD_SQL } from "#src/session/tasksDatabase/playablebench-domain-v4.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
type DatabaseSyncInstance = InstanceType<typeof DatabaseSync>;

interface ProjectRow {
  id: string;
  name: string;
  description: string | null;
  color: string | null;
  status: string;
  archived_at: number | null;
  created_at: number;
  updated_at: number;
}

interface NoteRow {
  id: string;
  title: string;
  body: string;
  project_id: string | null;
  created_at: number;
  updated_at: number;
}

interface LinkRow {
  project_id: string;
  link_kind: string;
  link_id: string;
  created_at: number;
}

function rowToProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    color: row.color ?? undefined,
    status: row.status as ProjectStatus,
    archivedAt: row.archived_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToNote(row: NoteRow): Note {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    projectId: row.project_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToLink(row: LinkRow): ProjectLink {
  return {
    projectId: row.project_id,
    kind: row.link_kind as ProjectLinkKind,
    linkId: row.link_id,
    createdAt: row.created_at,
  };
}

export class ProjectsRepo {
  private db: DatabaseSyncInstance | null = null;
  private dbPath: string | null = null;
  private initializePromise: Promise<void> | null = null;
  private readonly resolvedDbPath: string | null;

  constructor(
    dbPath?: string,
    private readonly startupBusyTimeoutMs = 5000,
  ) {
    this.resolvedDbPath = dbPath ?? null;
  }

  async ensureReady(): Promise<void> {
    const path = this.resolvedDbPath ?? getTasksIndexDatabasePath();
    if (this.dbPath && this.dbPath !== path) {
      this.close();
    }
    if (!this.initializePromise) {
      this.initializePromise = this.initialize(path).catch((error) => {
        this.close();
        throw error;
      });
    }
    await this.initializePromise;
  }

  private async initialize(path: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    if (!this.db) {
      this.db = new DatabaseSync(path);
      this.dbPath = path;
      this.db.exec(`PRAGMA busy_timeout = ${this.startupBusyTimeoutMs}`);
      this.db.exec("PRAGMA journal_mode = WAL");
      this.db.exec("PRAGMA synchronous = NORMAL");
    }
    if (!isTasksStoragePrepared(path, this.db)) {
      runTasksDatabaseMigrations(this.db);
    }
  }

  private getDatabase(): DatabaseSyncInstance {
    if (!this.db) {
      throw new Error("ProjectsRepo 未初始化：请先 await ensureReady()");
    }
    return this.db;
  }

  close(): void {
    try {
      this.db?.close();
    } catch {
      /* 关闭失败不影响调用方。 */
    }
    this.db = null;
    this.dbPath = null;
    this.initializePromise = null;
  }

  // ---- Projects ----

  async createProject(params: { name: string; description?: string; color?: string }): Promise<Project> {
    await this.ensureReady();
    const name = params.name.trim();
    if (!name) {
      throw new Error("项目名称不能为空");
    }
    const now = Date.now();
    const id = `project-${randomUUID()}`;
    this.getDatabase()
      .prepare(
        `INSERT INTO projects (id, name, description, color, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'active', ?, ?)`,
      )
      .run(id, name, params.description ?? null, params.color ?? null, now, now);
    const project = await this.getProject(id);
    if (!project) {
      throw new Error(`project 写入后缺少行: ${id}`);
    }
    return project;
  }

  async listProjects(params?: { status?: ProjectStatus }): Promise<Project[]> {
    await this.ensureReady();
    const rows = params?.status
      ? (this.getDatabase()
          .prepare(`SELECT * FROM projects WHERE status = ? ORDER BY updated_at DESC`)
          .all(params.status) as unknown as ProjectRow[])
      : (this.getDatabase()
          .prepare(`SELECT * FROM projects ORDER BY updated_at DESC`)
          .all() as unknown as ProjectRow[]);
    return rows.map(rowToProject);
  }

  async getProject(id: string): Promise<Project | null> {
    await this.ensureReady();
    const row = this.getDatabase()
      .prepare(`SELECT * FROM projects WHERE id = ?`)
      .get(id) as ProjectRow | undefined;
    return row ? rowToProject(row) : null;
  }

  async updateProject(
    id: string,
    params: { name?: string; description?: string | null; color?: string | null },
  ): Promise<Project | null> {
    await this.ensureReady();
    const existing = await this.getProject(id);
    if (!existing) {
      return null;
    }
    const name = params.name?.trim() || existing.name;
    this.getDatabase()
      .prepare(
        `UPDATE projects
         SET name = ?, description = ?, color = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        name,
        params.description === undefined ? existing.description ?? null : params.description,
        params.color === undefined ? existing.color ?? null : params.color,
        Date.now(),
        id,
      );
    return this.getProject(id);
  }

  /** 归档（不删除）：项目与其关联关系保留，仅退出活跃视图。 */
  async archiveProject(id: string): Promise<Project | null> {
    await this.ensureReady();
    const now = Date.now();
    this.getDatabase()
      .prepare(
        `UPDATE projects SET status = 'archived', archived_at = ?, updated_at = ? WHERE id = ?`,
      )
      .run(now, now, id);
    return this.getProject(id);
  }

  async restoreProject(id: string): Promise<Project | null> {
    await this.ensureReady();
    this.getDatabase()
      .prepare(
        `UPDATE projects SET status = 'active', archived_at = NULL, updated_at = ? WHERE id = ?`,
      )
      .run(Date.now(), id);
    return this.getProject(id);
  }

  // ---- Notes ----

  async createNote(params: { title?: string; body?: string; projectId?: string }): Promise<Note> {
    await this.ensureReady();
    if (params.projectId) {
      const project = await this.getProject(params.projectId);
      if (!project) {
        throw new Error(`关联的项目不存在: ${params.projectId}`);
      }
    }
    const now = Date.now();
    const id = `note-${randomUUID()}`;
    this.getDatabase()
      .prepare(
        `INSERT INTO notes (id, title, body, project_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, params.title?.trim() ?? "", params.body ?? "", params.projectId ?? null, now, now);
    if (params.projectId) {
      await this.link({ projectId: params.projectId, kind: "note", linkId: id });
    }
    const note = await this.getNote(id);
    if (!note) {
      throw new Error(`note 写入后缺少行: ${id}`);
    }
    return note;
  }

  async getNote(id: string): Promise<Note | null> {
    await this.ensureReady();
    const row = this.getDatabase()
      .prepare(`SELECT * FROM notes WHERE id = ?`)
      .get(id) as NoteRow | undefined;
    return row ? rowToNote(row) : null;
  }

  async listNotes(params?: { projectId?: string; limit?: number }): Promise<Note[]> {
    await this.ensureReady();
    const limit = Math.max(1, Math.min(params?.limit ?? 100, 500));
    const rows = params?.projectId
      ? (this.getDatabase()
          .prepare(`SELECT * FROM notes WHERE project_id = ? ORDER BY updated_at DESC LIMIT ?`)
          .all(params.projectId, limit) as unknown as NoteRow[])
      : (this.getDatabase()
          .prepare(`SELECT * FROM notes ORDER BY updated_at DESC LIMIT ?`)
          .all(limit) as unknown as NoteRow[]);
    return rows.map(rowToNote);
  }

  async updateNote(
    id: string,
    params: { title?: string; body?: string; projectId?: string | null },
  ): Promise<Note | null> {
    await this.ensureReady();
    const existing = await this.getNote(id);
    if (!existing) {
      return null;
    }
    const title = params.title?.trim() ?? existing.title;
    const body = params.body ?? existing.body;
    const projectId =
      params.projectId === undefined ? existing.projectId ?? null : params.projectId;
    this.getDatabase()
      .prepare(`UPDATE notes SET title = ?, body = ?, project_id = ?, updated_at = ? WHERE id = ?`)
      .run(title, body, projectId, Date.now(), id);
    return this.getNote(id);
  }

  /** 笔记删除为显式硬删（MVP 无回收站）；FTS 触发器同步清理索引。 */
  async deleteNote(id: string): Promise<boolean> {
    await this.ensureReady();
    const result = this.getDatabase()
      .prepare(`DELETE FROM notes WHERE id = ?`)
      .run(id);
    return result.changes > 0;
  }

  // ---- Links ----

  async link(params: { projectId: string; kind: ProjectLinkKind; linkId: string }): Promise<ProjectLink> {
    await this.ensureReady();
    const project = await this.getProject(params.projectId);
    if (!project) {
      throw new Error(`关联的项目不存在: ${params.projectId}`);
    }
    const now = Date.now();
    this.getDatabase()
      .prepare(
        `INSERT INTO project_links (project_id, link_kind, link_id, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(project_id, link_kind, link_id) DO NOTHING`,
      )
      .run(params.projectId, params.kind, params.linkId, now);
    const row = this.getDatabase()
      .prepare(
        `SELECT * FROM project_links WHERE project_id = ? AND link_kind = ? AND link_id = ?`,
      )
      .get(params.projectId, params.kind, params.linkId) as unknown as LinkRow;
    return rowToLink(row);
  }

  async unlink(params: { projectId: string; kind: ProjectLinkKind; linkId: string }): Promise<boolean> {
    await this.ensureReady();
    const result = this.getDatabase()
      .prepare(
        `DELETE FROM project_links WHERE project_id = ? AND link_kind = ? AND link_id = ?`,
      )
      .run(params.projectId, params.kind, params.linkId);
    return result.changes > 0;
  }

  async listLinks(params: { projectId?: string; kind?: ProjectLinkKind; linkId?: string }): Promise<ProjectLink[]> {
    await this.ensureReady();
    const where: string[] = [];
    const args: string[] = [];
    if (params.projectId) {
      where.push("project_id = ?");
      args.push(params.projectId);
    }
    if (params.kind) {
      where.push("link_kind = ?");
      args.push(params.kind);
    }
    if (params.linkId) {
      where.push("link_id = ?");
      args.push(params.linkId);
    }
    const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const rows = this.getDatabase()
      .prepare(`SELECT * FROM project_links ${clause} ORDER BY created_at DESC`)
      .all(...args) as unknown as LinkRow[];
    return rows.map(rowToLink);
  }

  /** FTS 与内容表失漂时的重建入口（spec 06 §3）；幂等。 */
  rebuildFullTextIndexes(): void {
    this.getDatabase().exec(PLAYABLEBENCH_FTS_REBUILD_SQL);
  }
}
