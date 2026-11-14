// 远程设备准入门测试（spec 09 §9 威胁清单的服务层部分 + spec 16 门禁）。
// 场景：未确认设备拒绝数据访问、scope 不足拒绝、白名单外 RPC 拒绝、
// requestId 重放返回先前结果、过期命令拒绝、撤销后立即拒绝、配对确认流程。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RemoteDeviceGate } from "#src/playablebench/remoteDeviceGate.js";
import { hashPairingCredential } from "@zcode/shared/node";
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

function makeGate() {
  const dir = mkdtempSync(join(tmpdir(), "zcode-remote-gate-"));
  tempDirs.push(dir);
  const connection = new RunStoreConnection(join(dir, "tasks-index.sqlite"));
  return new RemoteDeviceGate({ connection });
}

const SECRET = "pairing-secret-xyz";

async function makeConfirmedGate(tier: "read_only" | "instruction" | "approver" = "instruction") {
  const gate = makeGate();
  const session = await gate.ensureDeviceSession({
    credentialHash: hashPairingCredential(SECRET),
    deviceName: "测试手机",
  });
  const confirmed = await gate.confirmDevice(session.device.id, tier);
  return { gate, device: confirmed! };
}

describe("远程设备准入门", () => {
  it("新设备登记 pending：命令全部拒绝（未授权设备无法获得数据）", async () => {
    const gate = makeGate();
    const hash = hashPairingCredential(SECRET);
    const result = await gate.authorizeCommand({
      credentialHash: hash,
      commandType: "task_list",
      requestId: "req-1",
      payloadDigest: "d-1",
    });
    expect(result.ok).toBe(false);
    expect(result.rejection).toBe("device_unconfirmed");
    const events = await gate.listSecurityEvents();
    expect(events.some((event) => event.kind === "device_pending")).toBe(true);
  });

  it("确认后按能力档授权；scope 不足显式拒绝并记录", async () => {
    const { gate, device } = await makeConfirmedGate("read_only");
    const ok = await gate.authorizeCommand({
      credentialHash: hashPairingCredential(SECRET),
      commandType: "task_list",
      requestId: "req-2",
      payloadDigest: "d-2",
    });
    expect(ok.ok).toBe(true);
    const denied = await gate.authorizeCommand({
      credentialHash: hashPairingCredential(SECRET),
      commandType: "send_instruction",
      requestId: "req-3",
      payloadDigest: "d-3",
    });
    expect(denied.ok).toBe(false);
    expect(denied.rejection).toBe("scope_denied");
    expect(
      (await gate.listSecurityEvents()).some((event) => event.detail?.includes("scope denied")),
    ).toBe(true);
    void device;
  });

  it("白名单外 RPC 名称拒绝（远程输入不调用任意函数名）", async () => {
    const { gate } = await makeConfirmedGate("approver");
    const result = await gate.authorizeCommand({
      credentialHash: hashPairingCredential(SECRET),
      commandType: "arbitrary_shell_exec",
      requestId: "req-4",
      payloadDigest: "d-4",
    });
    expect(result.ok).toBe(false);
    expect(result.rejection).toBe("scope_denied");
  });

  it("requestId 重放：返回先前结果不再次执行（spec 09 §6）", async () => {
    const { gate } = await makeConfirmedGate("instruction");
    const hash = hashPairingCredential(SECRET);
    const first = await gate.authorizeCommand({
      credentialHash: hash,
      commandType: "send_instruction",
      requestId: "req-5",
      payloadDigest: "d-5",
    });
    expect(first.ok).toBe(true);
    expect(first.replayResult).toBeUndefined();
    await gate.settleCommand("req-5", '{"ok":true,"executed":1}');

    const replay = await gate.authorizeCommand({
      credentialHash: hash,
      commandType: "send_instruction",
      requestId: "req-5",
      payloadDigest: "d-5",
    });
    expect(replay.ok).toBe(true);
    expect(replay.replayResult?.resultJson).toBe('{"ok":true,"executed":1}');
  });

  it("过期命令拒绝；撤销后立即拒绝（撤销立即生效）", async () => {
    const { gate } = await makeConfirmedGate("instruction");
    const hash = hashPairingCredential(SECRET);
    const expired = await gate.authorizeCommand({
      credentialHash: hash,
      commandType: "send_instruction",
      requestId: "req-6",
      payloadDigest: "d-6",
      expiresAt: Date.now() - 1_000,
    });
    expect(expired.ok).toBe(false);
    expect(expired.rejection).toBe("command_expired");

    const devices = await gate.listDevices();
    const device = devices.find((entry) => entry.credentialHash === hash)!;
    await gate.revokeDevice(device.id, "user_request");
    const revoked = await gate.authorizeCommand({
      credentialHash: hash,
      commandType: "send_instruction",
      requestId: "req-7",
      payloadDigest: "d-7",
    });
    expect(revoked.ok).toBe(false);
    expect(revoked.rejection).toBe("device_revoked");
  });

  it("一键撤销全部后所有设备拒绝", async () => {
    const gate = makeGate();
    const hashA = hashPairingCredential("secret-a");
    const hashB = hashPairingCredential("secret-b");
    for (const hash of [hashA, hashB]) {
      const session = await gate.ensureDeviceSession({ credentialHash: hash });
      await gate.confirmDevice(session.device.id, "approver");
    }
    expect(await gate.revokeAllDevices("panic")).toBe(2);
    for (const hash of [hashA, hashB]) {
      const result = await gate.authorizeCommand({
        credentialHash: hash,
        commandType: "task_list",
        requestId: `req-${hash.slice(0, 6)}`,
        payloadDigest: "d",
      });
      expect(result.rejection).toBe("device_revoked");
    }
  });
});
