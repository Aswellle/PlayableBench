// 远程设备注册表与命令账本测试（spec 09 §3/§4/§6 门禁）。
// 断言：pending→确认→active 生命周期、能力档 scope 映射、撤销即时失效
// （凭据查找/scope 判定拒绝）、一键撤销全部、到期收敛、重复 requestId
// 返回先前结果不再次执行、过期命令拒绝。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RemoteDeviceScope } from "@zcode/shared";
import { RemoteCommandLedgerRepo } from "#src/session/remoteCommandLedgerRepo.js";
import { RemoteDeviceRepo } from "#src/session/remoteDeviceRepo.js";
import { RemoteSecurityEventRepo } from "#src/session/remoteSecurityEventRepo.js";
import { RunStoreConnection } from "#src/session/runStoreConnection.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch {
        // Windows 句柄释放延迟交给系统清理。
      }
    }
  }
});

function makeRepos() {
  const dir = mkdtempSync(join(tmpdir(), "zcode-remote-repo-"));
  tempDirs.push(dir);
  const connection = new RunStoreConnection(join(dir, "tasks-index.sqlite"));
  return {
    devices: new RemoteDeviceRepo(connection),
    ledger: new RemoteCommandLedgerRepo(connection),
    securityEvents: new RemoteSecurityEventRepo(connection),
  };
}

const CRED_HASH = "hash-abc-123";
const SCOPES: Array<{
  tier: "read_only" | "instruction" | "approver";
  scope: RemoteDeviceScope;
  allowed: boolean;
}> = [
  { tier: "read_only", scope: "read_status", allowed: true },
  { tier: "read_only", scope: "read_task", allowed: true },
  { tier: "read_only", scope: "send_instruction", allowed: false },
  { tier: "read_only", scope: "approve_operation", allowed: false },
  { tier: "instruction", scope: "send_instruction", allowed: true },
  { tier: "instruction", scope: "cancel_run", allowed: true },
  { tier: "instruction", scope: "approve_operation", allowed: false },
  { tier: "approver", scope: "approve_operation", allowed: true },
  { tier: "approver", scope: "manage_device", allowed: true },
];

describe("远程设备注册表", () => {
  it("配对登记 pending → 确认 active（能力档）；未确认不可认证", async () => {
    const { devices } = makeRepos();
    const pending = await devices.registerPending({
      name: "手机",
      deviceType: "phone",
      credentialHash: CRED_HASH,
    });
    expect(pending.status).toBe("pending");
    // 未确认：凭据查找不命中。
    expect(await devices.findActiveByCredentialHash(CRED_HASH)).toBeNull();

    const confirmed = await devices.confirm(pending.id, {
      tier: "instruction",
      expiresAt: Date.now() + 86_400_000,
    });
    expect(confirmed?.status).toBe("active");
    expect(confirmed?.tier).toBe("instruction");
    const authed = await devices.findActiveByCredentialHash(CRED_HASH);
    expect(authed?.id).toBe(pending.id);
    // 二次确认拒绝（状态机单次生效）。
    expect(await devices.confirm(pending.id, { tier: "approver" })).toBeNull();
  });

  it("能力档 → scope 映射固定；Host 端 allows 每命令重检", async () => {
    const { devices } = makeRepos();
    for (const entry of SCOPES) {
      const device = await devices.registerPending({
        name: `dev-${entry.tier}`,
        credentialHash: `hash-${entry.tier}-${entry.scope}`,
      });
      await devices.confirm(device.id, { tier: entry.tier });
      expect(await devices.allows(device.id, entry.scope)).toBe(entry.allowed);
    }
  });

  it("撤销即时失效：凭据查找与 scope 判定拒绝（spec 16 门禁）", async () => {
    const { devices, securityEvents } = makeRepos();
    const device = await devices.registerPending({ name: "手机", credentialHash: CRED_HASH });
    await devices.confirm(device.id, { tier: "approver" });
    expect(await devices.allows(device.id, "send_instruction")).toBe(true);

    const revoked = await devices.revoke(device.id, "user_request");
    expect(revoked?.status).toBe("revoked");
    expect(await devices.findActiveByCredentialHash(CRED_HASH)).toBeNull();
    expect(await devices.allows(device.id, "read_status")).toBe(false);
    // 撤销写入安全事件（spec 09 §8）；再次撤销不重复记事件。
    expect(await devices.revoke(device.id, "again")).not.toBeNull();
    const events = await securityEvents.list({ deviceId: device.id });
    const revokedEvents = events.filter((event) => event.kind === "device_revoked");
    expect(revokedEvents).toHaveLength(1);
  });

  it("一键撤销全部：只撤活跃设备；过期收敛 pending/active", async () => {
    const { devices } = makeRepos();
    const a = await devices.registerPending({ name: "A", credentialHash: "h-a" });
    await devices.confirm(a.id, { tier: "read_only" });
    const b = await devices.registerPending({ name: "B", credentialHash: "h-b" });
    await devices.confirm(b.id, { tier: "approver" });
    const pending = await devices.registerPending({ name: "C", credentialHash: "h-c" });

    expect(await devices.revokeAll("user_request")).toBe(2);
    expect((await devices.get(a.id))?.status).toBe("revoked");
    expect((await devices.get(b.id))?.status).toBe("revoked");
    expect((await devices.get(pending.id))?.status).toBe("pending");

    // 到期收敛：带过期时间的 pending 设备到期后 expired。
    const expiring = await devices.registerPending({
      name: "D",
      credentialHash: "h-d",
      expiresAt: Date.now() - 1_000,
    });
    expect(await devices.expireDue()).toBeGreaterThanOrEqual(1);
    expect((await devices.get(expiring.id))?.status).toBe("expired");
  });
});

describe("远程命令幂等账本", () => {
  it("重复 requestId 返回先前结果不再次执行；结算单次生效", async () => {
    const { ledger } = makeRepos();
    const first = await ledger.begin({
      requestId: "req-1",
      deviceId: "dev-1",
      commandType: "send_instruction",
      payloadDigest: "d-1",
    });
    expect(first.reused).toBe(false);
    await ledger.settle("req-1", { resultJson: '{"ok":true,"answer":42}' });

    // 重复提交：reused=true 且带先前结果（副作用不再次执行，spec 09 §6）。
    const replay = await ledger.begin({
      requestId: "req-1",
      deviceId: "dev-1",
      commandType: "send_instruction",
      payloadDigest: "d-1",
    });
    expect(replay.reused).toBe(true);
    expect(replay.entry.status).toBe("settled");
    expect(replay.entry.resultJson).toBe('{"ok":true,"answer":42}');
    // 二次结算无效（单次语义）。
    await ledger.settle("req-1", { resultJson: '{"ok":true,"answer":999}' });
    expect((await ledger.get("req-1"))?.resultJson).toBe('{"ok":true,"answer":42}');
  });

  it("过期命令收敛为 expired", async () => {
    const { ledger } = makeRepos();
    await ledger.begin({
      requestId: "req-exp",
      deviceId: "dev-1",
      commandType: "send_instruction",
      payloadDigest: "d-2",
      expiresAt: Date.now() - 1_000,
    });
    expect(await ledger.expireDue()).toBe(1);
    expect((await ledger.get("req-exp"))?.status).toBe("expired");
  });
});
