import { safeStorage } from "electron";
import { createVersionedCredentialCipherProvider, type CredentialCipherProvider } from "@zcode/services/node";
import { logger } from "./logger.js";

/**
 * 桌面 main 进程的凭据加密器（安全审计 SR-03）：
 * 通过 Electron safeStorage（Windows DPAPI / macOS 钥匙串）提供 OS 级加解密，
 * 取代仅对本机信息做混淆的 AES 方案。safeStorage 不可用时退回 v1 并落盘告警，
 * 降级通过日志/诊断导出可见，不做静默替换。
 */
export function createDesktopCredentialCipherProvider(): CredentialCipherProvider {
  const provider = createVersionedCredentialCipherProvider({
    hostBridge: {
      isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
      encryptString: (plaintext) => safeStorage.encryptString(plaintext),
      decryptString: (encoded) => safeStorage.decryptString(encoded),
    },
  });

  if (!safeStorage.isEncryptionAvailable()) {
    // 降级必须可见：日志进入诊断导出，便于发现凭据仍停留在混淆级保护。
    logger.warn("[credential] OS secure storage is unavailable; falling back to legacy credential encryption");
  }

  return provider;
}

