// 信息到工作流闭环域类型（spec 06 §2 WorkflowTemplate、spec 08 §9 摘要）。
// 纯类型文件，renderer 安全。模板版本发布后不可静默改变旧 run 的执行定义：
// 新版本以显式 version 另存一行（id+version 复合主键），spec 05 §8。
export interface PbWorkflowTemplate {
  id: string;
  version: string;
  name: string;
  /** 输入 schema（JSON 串，具体校验归服务层）。 */
  inputSchema?: string;
  /** 步骤/条件定义（JSON 串）。 */
  definition?: string;
  /** 所需工具权限（JSON 串；白名单与 TOOL_POLICY_REGISTRY 取交集，spec 05 §4）。 */
  permissions?: string;
  /** 审批点策略（JSON 串）。 */
  approvalPolicy?: string;
  /** 输出 schema（JSON 串）。 */
  outputSchema?: string;
  /** 验证规则（JSON 串）。 */
  verificationRules?: string;
  createdAt: number;
}

/** 摘要引用片段（spec 08 §9：保存引用片段/位置，可获得时）。 */
export interface PbSummaryCitation {
  url?: string;
  text: string;
  /** 原文中的位置描述（可获得时，如段落序号）。 */
  locator?: string;
}

/**
 * 卡片 AI 摘要记录（spec 08 §9）：保存原文 URL、标题、生成模型/时间与
 * 引用片段；runId 使摘要可追溯到产生它的研究运行（门禁：摘要可追溯）。
 * 缓存语义：相同内容在摘要模型/版本未变化时复用（(content_hash, model,
 * model_version) 唯一），模型或内容变化则重新生成。
 */
export interface PbFeedSummary {
  id: string;
  feedItemId: string;
  contentHash?: string;
  sourceUrl: string;
  title: string;
  model: string;
  modelVersion: string;
  summaryText: string;
  citations: PbSummaryCitation[];
  runId?: string;
  noteId?: string;
  createdAt: number;
}
