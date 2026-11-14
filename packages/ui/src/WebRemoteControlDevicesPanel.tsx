// 远程设备管理面板（spec 09 §4、裁决 SR-04）：设备列表（pending 确认/拒绝 +
// active 撤销）+ 一键撤销全部。嵌入 WebRemoteControlDialog；撤销立即生效由
// IPC 层保证（撤销后停对应窗口远控，强制断开既有 WS）。
import { memo, useCallback, useState } from "react";
import { CheckCircle2, LoaderCircle, RefreshCw, ShieldOff, Trash2, XCircle } from "lucide-react";
import type { IPlatformService, RemoteDevice, RemoteDeviceTier } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { usePlatform } from "@/hooks/usePlatform.jsx";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";

type DeviceListResult = Awaited<ReturnType<NonNullable<IPlatformService["listRemoteDevices"]>>>;

const TIER_OPTIONS: Array<{ value: RemoteDeviceTier; labelId: string }> = [
  { value: "read_only", labelId: "webRemoteControl.devices.tierReadOnly" },
  { value: "instruction", labelId: "webRemoteControl.devices.tierInstruction" },
  { value: "approver", labelId: "webRemoteControl.devices.tierApprover" },
];

export const WebRemoteControlDevicesPanel = memo(function WebRemoteControlDevicesPanel(props: {
  windowId?: number;
}) {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const [devices, setDevices] = useState<DeviceListResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [confirmTiers, setConfirmTiers] = useState<Record<string, RemoteDeviceTier>>({});

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setDevices(((await platform.listRemoteDevices?.()) ?? []) as DeviceListResult);
    } catch (error) {
      logger.warn("[WebRemoteControlDevicesPanel] 设备列表加载失败", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setLoading(false);
    }
  }, [platform]);

  const handleConfirm = useCallback(
    async (deviceId: string) => {
      const tier = confirmTiers[deviceId] ?? "read_only";
      try {
        await platform.confirmRemoteDevice?.({ deviceId, tier });
        await refresh();
      } catch (error) {
        logger.warn("[WebRemoteControlDevicesPanel] 确认设备失败", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [confirmTiers, platform, refresh],
  );

  const handleRevoke = useCallback(
    async (deviceId: string) => {
      try {
        await platform.revokeRemoteDevice?.({
          deviceId,
          reason: "user_request",
          ...(props.windowId !== undefined ? { windowId: props.windowId } : {}),
        });
        await refresh();
      } catch (error) {
        logger.warn("[WebRemoteControlDevicesPanel] 撤销设备失败", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [platform, props.windowId, refresh],
  );

  const handleRevokeAll = useCallback(async () => {
    try {
      await platform.revokeAllRemoteDevices?.({ reason: "user_request" });
      await refresh();
    } catch (error) {
      logger.warn("[WebRemoteControlDevicesPanel] 一键撤销失败", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, [platform, refresh]);

  const pending = devices?.filter((device) => device.status === "pending") ?? [];
  const active = devices?.filter((device) => device.status === "active") ?? [];
  const tierLabel = (device: RemoteDevice) =>
    intl.formatMessage({
      id:
        TIER_OPTIONS.find((option) => option.value === device.tier)?.labelId ??
        "webRemoteControl.devices.tierReadOnly",
    });

  return (
    <section
      aria-label={intl.formatMessage({ id: "webRemoteControl.devices.title" })}
      className="flex flex-col gap-2 rounded-xl border border-border bg-card p-4"
      data-testid="web-remote-control-devices"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="text-ui-base font-medium text-foreground">
          {intl.formatMessage({ id: "webRemoteControl.devices.title" })}
        </div>
        <div className="flex gap-1.5">
          <Button
            type="button"
            variant="ghost"
            size="default"
            onClick={() => void refresh()}
            disabled={loading}
          >
            <RefreshCw className={loading ? "size-3.5 animate-spin" : "size-3.5"} />
            {intl.formatMessage({ id: "webRemoteControl.devices.refresh" })}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="default"
            className="gap-1.5 text-destructive enabled:cursor-pointer hover:text-destructive"
            onClick={() => void handleRevokeAll()}
            disabled={loading || active.length === 0}
          >
            <ShieldOff className="size-3.5" />
            {intl.formatMessage({ id: "webRemoteControl.devices.revokeAll" })}
          </Button>
        </div>
      </div>

      {devices === null ? (
        <Button type="button" variant="ghost" size="default" onClick={() => void refresh()}>
          {intl.formatMessage({ id: "webRemoteControl.devices.load" })}
        </Button>
      ) : devices.length === 0 ? (
        <p className="text-ui-base/relaxed text-foreground-subtle">
          {intl.formatMessage({ id: "webRemoteControl.devices.empty" })}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {[...pending, ...active].map((device) => (
            <li
              key={device.id}
              className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2"
            >
              <div className="flex min-w-0 flex-col">
                <span className="truncate text-ui-base/relaxed text-foreground">
                  {device.name}
                  {device.deviceType ? ` · ${device.deviceType}` : ""}
                </span>
                <span className="truncate text-ui-base/relaxed text-foreground-subtle">
                  {device.status === "pending"
                    ? intl.formatMessage({ id: "webRemoteControl.devices.pending" })
                    : device.status === "active"
                      ? tierLabel(device)
                      : intl.formatMessage({ id: "webRemoteControl.devices.revoked" })}
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                {device.status === "pending" ? (
                  <>
                    <select
                      aria-label={intl.formatMessage({ id: "webRemoteControl.devices.tierLabel" })}
                      className="rounded-lg border border-border bg-background px-2 py-1.5 text-ui-base/relaxed text-foreground outline-none"
                      value={confirmTiers[device.id] ?? "read_only"}
                      onChange={(event) =>
                        setConfirmTiers((prev) => ({
                          ...prev,
                          [device.id]: event.target.value as RemoteDeviceTier,
                        }))
                      }
                    >
                      {TIER_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {intl.formatMessage({ id: option.labelId })}
                        </option>
                      ))}
                    </select>
                    <Button
                      type="button"
                      variant="outline"
                      size="default"
                      aria-label={intl.formatMessage({ id: "webRemoteControl.devices.reject" })}
                      onClick={() => void handleRevoke(device.id)}
                    >
                      <XCircle className="size-3.5" />
                    </Button>
                    <Button
                      type="button"
                      variant="default"
                      size="default"
                      onClick={() => void handleConfirm(device.id)}
                    >
                      <CheckCircle2 className="size-3.5" />
                      {intl.formatMessage({ id: "webRemoteControl.devices.confirm" })}
                    </Button>
                  </>
                ) : device.status === "active" ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="default"
                    className="gap-1.5 text-destructive enabled:cursor-pointer hover:text-destructive"
                    aria-label={intl.formatMessage({ id: "webRemoteControl.devices.revoke" })}
                    onClick={() => void handleRevoke(device.id)}
                  >
                    <Trash2 className="size-3.5" />
                    {intl.formatMessage({ id: "webRemoteControl.devices.revoke" })}
                  </Button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
      {loading && devices !== null ? (
        <LoaderCircle className="size-3.5 animate-spin self-center text-foreground-subtle" />
      ) : null}
    </section>
  );
});
