// 审批操作摘要 digest（spec 05 §3：waiting_approval 必须绑定具体操作 digest，
// 参数或目标变化需重新审批）。规范化 JSON（键排序、剔除 undefined）后 sha256，
// 同一操作语义得到同一 digest；入参变化/目标变化 → digest 变化 → 原审批失效。
// 摘要一律基于脱敏后的请求内容计算（与落库的 request_json 同源），保证
// 复核方可重算比对；凭据等敏感值不得进入 digest 输入。
import { createHash } from "node:crypto";

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([k, v]) => [k, canonicalize(v)]));
  }
  return value;
}

export interface OperationDigestInput {
  toolId: string;
  /** V4 工具调用 id；同一次调用的重放共享 digest。 */
  toolCallId?: string;
  /** 工具入参（脱敏后的形态）；参数变化必然改变 digest。 */
  input?: unknown;
  /** 操作目标（文件路径、URL、收件人等）；目标变化必然改变 digest。 */
  target?: string;
}

export function computeOperationDigest(input: OperationDigestInput): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(input)))
    .digest("hex");
}
