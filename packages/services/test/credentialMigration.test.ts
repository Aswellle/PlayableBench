import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCredentialService,
  migrateLegacyCredentialEntries,
} from "../src/credential/credentialService.js";
import { createVersionedCredentialCipherProvider } from "../src/credential/providers/credentialVersionedCipherProvider.js";

const originalHome = process.env.HOME;
const tempHomes: string[] = [];

function makeTempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "zcode-credential-migrate-"));
  tempHomes.push(home);
  return home;
}

function getCredentialsFile(home: string): string {
  return join(home, ".zcode", "v2", "credentials.json");
}

function createFakeHostBridge(): HostCredentialCipherBridge & { store: Map<string, string> } {
  const store = new Map<string, string>();
  let counter = 0;
  return {
    store,
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => {
      counter += 1;
      store.set(String(counter), plaintext);
      return Buffer.from(`os-blob-${counter}`);
    },
    decryptString: (encoded: Buffer) => {
      const key = encoded.toString("utf8").replace("os-blob-", "");
      const value = store.get(key);
      if (value === undefined) {
        throw new Error("decrypt failed");
      }
      return value;
    },
  };
}

afterEach(() => {
  process.env.HOME = originalHome;
  while (tempHomes.length > 0) {
    const home = tempHomes.pop();
    if (home) {
      rmSync(home, { recursive: true, force: true });
    }
  }
  vi.unstubAllEnvs();
});

describe("migrateLegacyCredentialEntries", () => {
  it("把 v1 密文重加密为宿主 OS 级格式且原值可读", async () => {
    const home = makeTempHome();
    process.env.HOME = home;
    vi.resetModules();
    const mod = await import("../src/credential/credentialService.js");
    const legacyService = mod.createCredentialService();
    // 先以 v1（默认无宿主桥）写入两枚键。
    await legacyService.save("desktop-only-key", "desktop-secret");
    await legacyService.save("shared-oauth-key", "oauth-secret");

    const bridge = createFakeHostBridge();
    const versionedProvider = createVersionedCredentialCipherProvider({ hostBridge: bridge });
    const result = await mod.migrateLegacyCredentialEntries({
      keys: ["desktop-only-key"],
      cipherProvider: versionedProvider,
    });

    expect(result.migrated).toEqual(["desktop-only-key"]);
    const raw = JSON.parse(readFileSync(getCredentialsFile(home), "utf-8")) as Record<string, string>;
    expect(raw["desktop-only-key"].startsWith("enc:v2:")).toBe(true);
    // 未列入迁移清单的共享键保持 v1，Host/CLI 仍可解密。
    expect(raw["shared-oauth-key"].startsWith("enc:v1:")).toBe(true);
    // 迁移后经由同一 versioned provider 读回原值。
    const migratedService = mod.createCredentialService({ cipherProvider: versionedProvider });
    await expect(migratedService.load("desktop-only-key")).resolves.toBe("desktop-secret");
  });

  it("缺失键与已迁移键按 skipped 处理，不报错", async () => {
    const home = makeTempHome();
    process.env.HOME = home;
    vi.resetModules();
    const mod = await import("../src/credential/credentialService.js");
    const bridge = createFakeHostBridge();
    const versionedProvider = createVersionedCredentialCipherProvider({ hostBridge: bridge });
    const service = mod.createCredentialService({ cipherProvider: versionedProvider });
    await service.save("already-v2", "value");

    const result = await mod.migrateLegacyCredentialEntries({
      keys: ["already-v2", "never-existed"],
      cipherProvider: versionedProvider,
    });

    expect(result.migrated).toEqual([]);
    expect(result.skipped).toEqual([
      { key: "already-v2", reason: "already-migrated" },
      { key: "never-existed", reason: "missing" },
    ]);
  });

  it("解密失败的键保留原值并记录 skipped", async () => {
    const home = makeTempHome();
    process.env.HOME = home;
    vi.resetModules();
    const mod = await import("../src/credential/credentialService.js");
    const legacyService = mod.createCredentialService();
    await legacyService.save("broken-key", "value");

    const brokenProvider = {
      decrypt: (value: string) => {
        if (value.startsWith("enc:v1:")) {
          throw new Error("模拟解密失败");
        }
        return value;
      },
      encrypt: (value: string) => `enc:v2:${Buffer.from(value).toString("base64")}`,
    };
    const result = await mod.migrateLegacyCredentialEntries({
      keys: ["broken-key"],
      cipherProvider: brokenProvider,
    });

    expect(result.migrated).toEqual([]);
    expect(result.skipped).toEqual([{ key: "broken-key", reason: "模拟解密失败" }]);
    const raw = JSON.parse(readFileSync(getCredentialsFile(home), "utf-8")) as Record<string, string>;
    expect(raw["broken-key"].startsWith("enc:v1:")).toBe(true);
  });
});
