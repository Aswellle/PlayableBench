import {
  CREDENTIAL_DECRYPT_ERROR_CODE,
  CREDENTIAL_DECRYPT_ERROR_PREFIX,
} from "@zcode/shared";
import {
  createCredentialCipherProvider,
  type CredentialCipherProvider,
} from "./credentialCipherProvider.js";

/**
 * 宿主进程提供的 OS 级加解密桥（桌面端 = Electron safeStorage，仅 main 进程可用）。
 * CLI/server 等无 Electron 宿主不注入该桥，自动退回 v1（AES + 本机推导密钥）。
 */
export interface HostCredentialCipherBridge {
  isEncryptionAvailable(): boolean;
  encryptString(plaintext: string): Buffer;
  decryptString(encoded: Buffer): string;
}

export interface VersionedCredentialCipherProviderOptions {
  hostBridge?: HostCredentialCipherBridge;
  logger?: {
    info: (...args: unknown[] | [string, unknown]) => unknown;
    warn: (...args: unknown[] | [string, unknown]) => unknown;
  };
}

const V2_ENCRYPTED_VALUE_PREFIX = "enc:v2:";
const V1_ENCRYPTED_VALUE_PREFIX = "enc:v1:";

function createCredentialDecryptError(reason: string): Error & {
  code: typeof CREDENTIAL_DECRYPT_ERROR_CODE;
} {
  return Object.assign(new Error(`${CREDENTIAL_DECRYPT_ERROR_PREFIX}${reason}`), {
    code: CREDENTIAL_DECRYPT_ERROR_CODE,
  });
}

/**
 * 按密文前缀路由的版本化凭据加密器（安全审计 SR-03）：
 * - 写入优先使用宿主 OS 级加密（enc:v2:）；宿主桥不可用时退回 v1，并由调用方保证降级可见。
 * - 读取按前缀路由：enc:v2: 必须有宿主桥，enc:v1: 走既有 AES 实现，无前缀按历史明文透传。
 * v1/v2 可共存于同一 credentials.json：前缀自描述，跨进程读取互不破坏。
 */
export function createVersionedCredentialCipherProvider(
  options: VersionedCredentialCipherProviderOptions = {},
): CredentialCipherProvider {
  const v1Provider = createCredentialCipherProvider();

  return {
    encrypt(value: string): string {
      const bridge = options.hostBridge;
      if (bridge && bridge.isEncryptionAvailable()) {
        return V2_ENCRYPTED_VALUE_PREFIX + bridge.encryptString(value).toString("base64");
      }
      return v1Provider.encrypt(value);
    },

    decrypt(value: string): string {
      if (value.startsWith(V2_ENCRYPTED_VALUE_PREFIX)) {
        const bridge = options.hostBridge;
        if (!bridge || !bridge.isEncryptionAvailable()) {
          throw createCredentialDecryptError("宿主 OS 级解密能力不可用");
        }
        const encoded = value.slice(V2_ENCRYPTED_VALUE_PREFIX.length);
        let decoded: Buffer;
        try {
          decoded = Buffer.from(encoded, "base64");
        } catch {
          throw createCredentialDecryptError("v2 密文 base64 非法");
        }
        try {
          return bridge.decryptString(decoded);
        } catch {
          throw createCredentialDecryptError("宿主解密失败（密钥不匹配或密文已损坏）");
        }
      }
      return v1Provider.decrypt(value);
    },
  };
}

export function isV2EncryptedCredentialValue(value: string): boolean {
  return value.startsWith(V2_ENCRYPTED_VALUE_PREFIX);
}

export function isLegacyEncryptedCredentialValue(value: string): boolean {
  return value.startsWith(V1_ENCRYPTED_VALUE_PREFIX);
}
