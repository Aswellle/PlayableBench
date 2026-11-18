# Web 远程控制 relay 数据流与安全边界说明

> 本文面向 spec 16 Phase 7 门禁"安全架构与数据流说明公开"与 spec 09 §5（无端口转发的远程架构）。核验日期 2026-11-16；relay 服务端不在本仓库，本文描述 Host 侧已实现的行为与 relay 的角色边界。

## 1. 架构总览（不要求端口转发）

```
手机浏览器 / Android 壳
        │ wss（出站，TLS）
        ▼
外部 relay（wss://…，服务端不在本仓库）
        ▲ wss（Host 主动出站连接，无需端口转发/公网 IP）
        │
桌面 Host（webRemoteControlManager）
        │ web-remote-replayable attachment（窗口共享 Host）
        ▼
同一 CLI 运行时（会话事实唯一所有者）
```

- 桌面 Host **默认只连 relay 的出站 WSS**，不监听任何 LAN/公网端口（spec 09 §5"Host 默认只监听 loopback/受限本地接口"——远控数据面全经 relay 中转）。
- relay 只路由已配对会话的帧；**不提供通用文件系统/命令执行 API**（spec 09 §5）。Host 侧命令面是严格白名单 RPC（`WebRemoteControlPlatformMethod` 固定 map + 手机任务面命令经设备准入门的 scope 重检），远程输入不能调用白名单外函数名。

## 2. relay 可见数据清单（明确标注：非端到端加密）

当前链路 **relay 可以看到 WSS 帧明文**（TLS 终止于 relay）。可见内容包括：

| 类别 | 示例 | 是否可见 |
|---|---|---|
| 会话帧元数据 | topic、subscriptionId、seq、时间戳 | 可见 |
| 对话内容 | 用户消息、助手回复、工具调用行 | 可见（帧明文） |
| 工具输入 | 命令、路径、URL | 可见 |
| 配对材料 | QR 参数（deviceSid、passHash）、认证 challenge/response | 可见（配对帧） |
| 文件内容 | 附件/大文本（经帧传输时） | 可见 |

**缓解措施（Host 侧已实现）**：HMAC-SHA256 challenge-response 认证、`/ws` 强制 replayable（快照+对账恢复）、命令白名单 + Host 端逐条授权（设备准入门 scope 重检）、requestId 幂等账本防重放、设备撤销即时失效。relay 仅中转：无 Host 凭据即无法伪造 Host 响应，但**无法阻止 relay 读取帧明文**。

如需端到端加密，需在客户端与 Host 之间建立 relay 无法解密的外层密钥协商——当前未实现，产品与发布说明**不得宣称端到端加密**。

## 3. 日志纪律（spec 09 §8）

- 采集日志不包含 cookie、token 或完整敏感查询参数。
- 安全事件落库（`pb_remote_security_events`）：绑定/撤销/认证失败/命令拒绝/审批/会话结束；detail 只含摘要（如 `scope denied: send_instruction for tier read_only`）。
- relay 消息日志（`webRemoteControlRelayLogger`）用于诊断，不记录完整敏感输入。

## 4. 性能 / 费用 / 来源条款可观察

| 项 | 位置 |
|---|---|
| GitHub Releases 条款与限额 | `FeedSourceCapabilities.limitations`（"upstream rate limiting may apply (unauthenticated requests)"）+ `termsUrl`（docs.github.com/site-policy/github-terms）落库并在来源管理可见 |
| HackerNews 条款 | `termsUrl`（ycombinator.com/legal/terms-of-use）+ limitations（topstories 快照语义、无凭据退避） |
| 能力声明核验日期 | `lastValidatedAt: "2026-11-16"`（spec 19 §4：正式实现前必须重新核验） |
| 费用 | 本批 connector 均为无凭据公开端点，无按条计费；未来接入计费 API（如 X）时必须在能力声明与 UI 提供预算上限与关闭开关（spec 19 §2 X 行） |

## 5. 威胁测试覆盖映射（spec 09 §9）

| 威胁 | 已有测试 |
|---|---|
| 二维码过期重用 | `isWebRemoteControlQrExpired`（TTL 5min/skew 2min）+ 配对短时限 |
| 设备撤销后已连接 WS | `remoteDeviceRepo`/`remoteDeviceGate`（撤销即时拒绝）+ IPC 停对应窗口远控 |
| requestId 重放 | `remoteCommandLedgerRepo`（重复返回先前结果）+ manager 重放告警 |
| scope 不足/白名单外 RPC | `remoteDeviceGate`（六类 scope × 三能力档 + 命令白名单） |
| 并发审批 | `approvalRepo.decideOnce` CAS |
| 未授权设备获取数据 | gate 拒绝（pending/revoked/expired 全拒） |
| 日志泄漏 token | 安全事件 detail 摘要纪律 + relay 日志红线（本文 §3） |
