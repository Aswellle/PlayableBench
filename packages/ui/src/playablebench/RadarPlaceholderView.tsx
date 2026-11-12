// Information Radar 占位页（Phase 2）：显式"未启用"状态。
// spec 04 约束：禁止把占位能力宣传为可用；不用假数据冒充真实能力。
// Radar 实装在 Phase 4（信息雷达基础版）；届时替换本组件并保留导航入口。
import { Radar as RadarIcon } from "lucide-react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export function RadarPlaceholderView() {
  const { intl } = useZCodeIntl();
  return (
    <div
      className="flex min-h-64 flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border bg-surface p-8"
      data-testid="playablebench-radar-placeholder"
    >
      <RadarIcon className="size-8 text-foreground-subtle" aria-hidden="true" />
      <p className="text-ui-base/relaxed font-medium text-foreground">
        {intl.formatMessage({ id: "playablebench.radar.title" })}
      </p>
      <p className="text-ui-base/relaxed text-foreground-subtle">
        {intl.formatMessage({ id: "playablebench.radar.notEnabled" })}
      </p>
    </div>
  );
}
