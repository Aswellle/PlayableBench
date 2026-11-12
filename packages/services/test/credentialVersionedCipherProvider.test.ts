import { describe, expect, it } from "vitest";
import type { HostCredentialCipherBridge } from "../src/credential/providers/credentialVersionedCipherProvider.js";
import {
  createVersionedCredentialCipherProvider,
  isLegacyEncryptedCredentialValue,
  isV2EncryptedCredentialValue,
} from "../src/credential/providers/credentialVersionedCipherProvider.js";
import { CREDENTIAL_DECRYPT_ERROR_PREFIX } from "@zcode/shared";

function createFakeHostBridge(options?: { available?: boolean }): HostCredentialCipherBridge & {
  encrypted: string[];
} {
  const store = new Map<string, string>();
  let counter = 0;
  return {
    encrypted: [],
    isEncryptionAvailable: () => options?.available ?? true,
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

describe("createVersionedCredentialCipherProvider", () => {
  it("宿主桥可用时写入 enc:v2: 并可解密回原文", () => {
    const bridge = createFakeHostBridge();
    const provider = createVersionedCredentialCipherProvider({ hostBridge: bridge });

    const encrypted = provider.encrypt("secret-value");
    expect(encrypted.startsWith("enc:v2:")).toBe(true);
    expect(provider.decrypt(encrypted)).toBe("secret-value");
  });

  it("宿主桥不可用时写入退回 v1 且仍可解密", () => {
    const bridge = createFakeHostBridge({ available: false });
    const provider = createVersionedCredentialCipherProvider({ hostBridge: bridge });

    const encrypted = provider.encrypt("secret-value");
    expect(isLegacyEncryptedCredentialValue(encrypted)).toBe(true);
    expect(isV2EncryptedCredentialValue(encrypted)).toBe(false);
    expect(provider.decrypt(encrypted)).toBe("secret-value");
  });

  it("无宿主桥（CLI/server 形态）保持 v1 行为", () => {
    const provider = createVersionedCredentialCipherProvider();

    const encrypted = provider.encrypt("secret-value");
    expect(isLegacyEncryptedCredentialValue(encrypted)).toBe(true);
    expect(provider.decrypt(encrypted)).toBe("secret-value");
  });

  it("可解密宿主写入的 v2 密文，也能解密外部 v1 密文（前缀路由）", () => {
    const bridge = createFakeHostBridge();
    const provider = createVersionedCredentialCipherProvider({ hostBridge: bridge });
    const v2Value = provider.encrypt("from-desktop");

    const legacyProvider = createVersionedCredentialCipherProvider();
    const v1Value = legacyProvider.encrypt("legacy-value");

    expect(provider.decrypt(v2Value)).toBe("from-desktop");
    expect(provider.decrypt(v1Value)).toBe("legacy-value");
  });

  it("无宿主桥时读取 v2 密文抛出带错误码的解密错误", () => {
    const bridge = createFakeHostBridge();
    const desktopProvider = createVersionedCredentialCipherProvider({ hostBridge: bridge });
    const v2Value = desktopProvider.encrypt("secret");

    const headlessProvider = createVersionedCredentialCipherProvider();
    try {
      headlessProvider.decrypt(v2Value);
      throw new Error("expected decrypt to throw");
    } catch (error) {
      expect((error as Error & { code?: string }).code).toBeDefined();
      expect((error as Error).message).toContain(CREDENTIAL_DECRYPT_ERROR_PREFIX);
    }
  });

  it("宿主解密失败时抛出解密错误而不是透传密文", () => {
    const bridge = createFakeHostBridge();
    const provider = createVersionedCredentialCipherProvider({ hostBridge: bridge });
    provider.encrypt("secret");
    const corrupted = `enc:v2:${Buffer.from("os-blob-missing").toString("base64")}`;

    expect(() => provider.decrypt(corrupted)).toThrowError(/解密失败/);
  });
});
