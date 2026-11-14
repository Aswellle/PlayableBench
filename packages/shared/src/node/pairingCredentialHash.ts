// 配对凭证哈希（spec 06 §2、spec 09 §8）：注册表只保存可验证哈希，不保存
// 原始 token/passHash。sha256 即可——凭证本身是高熵随机值，不是低熵口令，
// 无需口令哈希的慢函数。
import { createHash } from "node:crypto";

export function hashPairingCredential(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}
