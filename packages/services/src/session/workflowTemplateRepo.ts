// WorkflowTemplate 存储（spec 05 §8、spec 06 §2）。模板版本发布后不可静默
// 改变旧 run 的执行定义：种子模板只在缺失时插入，已存在行不覆写；新版本以
// 显式 version 另存一行。与 Run 域共享 tasks-index 库（RunStoreConnection）。
import type { PbWorkflowTemplate } from "@zcode/shared";
import type { RunStoreConnection } from "#src/session/runStoreConnection.js";

interface TemplateRow {
  id: string;
  version: string;
  name: string;
  input_schema: string | null;
  definition: string | null;
  permissions: string | null;
  approval_policy: string | null;
  output_schema: string | null;
  verification_rules: string | null;
  created_at: number;
}

function rowToTemplate(row: TemplateRow): PbWorkflowTemplate {
  return {
    id: row.id,
    version: row.version,
    name: row.name,
    ...(row.input_schema !== null ? { inputSchema: row.input_schema } : {}),
    ...(row.definition !== null ? { definition: row.definition } : {}),
    ...(row.permissions !== null ? { permissions: row.permissions } : {}),
    ...(row.approval_policy !== null ? { approvalPolicy: row.approval_policy } : {}),
    ...(row.output_schema !== null ? { outputSchema: row.output_schema } : {}),
    ...(row.verification_rules !== null ? { verificationRules: row.verification_rules } : {}),
    createdAt: row.created_at,
  };
}

export interface WorkflowTemplateSeed {
  id: string;
  version: string;
  name: string;
  inputSchema?: string;
  definition?: string;
  permissions?: string;
  approvalPolicy?: string;
  outputSchema?: string;
  verificationRules?: string;
}

export class WorkflowTemplateRepo {
  constructor(private readonly connection: RunStoreConnection) {}

  async ensureReady(): Promise<void> {
    await this.connection.ensureReady();
  }

  /** 种子模板：缺失时插入；已存在（含定义不同）不覆写——版本内容不可静默变更。 */
  async ensure(seed: WorkflowTemplateSeed): Promise<PbWorkflowTemplate> {
    await this.ensureReady();
    const db = this.connection.getDatabase();
    const now = Date.now();
    db.prepare(
      `INSERT OR IGNORE INTO pb_workflow_templates
         (id, version, name, input_schema, definition, permissions, approval_policy,
          output_schema, verification_rules, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      seed.id,
      seed.version,
      seed.name,
      seed.inputSchema ?? null,
      seed.definition ?? null,
      seed.permissions ?? null,
      seed.approvalPolicy ?? null,
      seed.outputSchema ?? null,
      seed.verificationRules ?? null,
      now,
    );
    const row = db
      .prepare(`SELECT * FROM pb_workflow_templates WHERE id = ? AND version = ?`)
      .get(seed.id, seed.version) as unknown as TemplateRow;
    return rowToTemplate(row);
  }

  async get(id: string, version: string): Promise<PbWorkflowTemplate | null> {
    await this.ensureReady();
    const row = this.connection
      .getDatabase()
      .prepare(`SELECT * FROM pb_workflow_templates WHERE id = ? AND version = ?`)
      .get(id, version) as unknown as TemplateRow | undefined;
    return row ? rowToTemplate(row) : null;
  }

  async listVersions(id: string): Promise<PbWorkflowTemplate[]> {
    await this.ensureReady();
    const rows = this.connection
      .getDatabase()
      .prepare(`SELECT * FROM pb_workflow_templates WHERE id = ? ORDER BY created_at ASC`)
      .all(id) as unknown as TemplateRow[];
    return rows.map(rowToTemplate);
  }
}
