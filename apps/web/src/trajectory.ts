import type {
  HttpExchange,
  ProtocolEvent,
  ProtocolEventKind,
} from "@ilink-trace/contracts";

export type TrajectoryCategory =
  "user" | "result" | "tool" | "system" | "error";

export type TrajectoryTimelineMode = "sequence" | "time";

export interface TrajectoryCategoryMeta {
  label: string;
  shortLabel: string;
  description: string;
}

export interface TrajectorySpan {
  event: ProtocolEvent;
  category: TrajectoryCategory;
  lane: 0 | 1 | 2;
  leftPercent: number;
  rightPercent: number;
  widthPercent: number;
  durationMs: number | null;
}

export interface TrajectoryTimeline {
  start: number;
  end: number;
  durationMs: number;
  spans: TrajectorySpan[];
}

export interface ObservedOutcome {
  tone: "success" | "warning" | "error" | "neutral";
  transport: string;
  business: string;
  delivery: string;
}

export const TRAJECTORY_CATEGORY_META: Record<
  TrajectoryCategory,
  TrajectoryCategoryMeta
> = {
  user: {
    label: "用户输入",
    shortLabel: "用户",
    description: "从 getupdates 观察到的入站消息",
  },
  result: {
    label: "返回结果",
    shortLabel: "结果",
    description: "Bot 通过 sendmessage 提交的回复",
  },
  tool: {
    label: "工具 / 协议调用",
    shortLabel: "调用",
    description: "配置、输入态、上传与生命周期调用",
  },
  system: {
    label: "系统事件",
    shortLabel: "系统",
    description: "轮询与登录等观测事件",
  },
  error: {
    label: "异常",
    shortLabel: "异常",
    description: "网络或协议解析异常",
  },
};

export function categoryForEvent(kind: ProtocolEventKind): TrajectoryCategory {
  if (kind === "inbound_message") return "user";
  if (kind === "outbound_message") return "result";
  if (kind === "protocol_error") return "error";
  if (
    kind === "config" ||
    kind === "typing" ||
    kind === "upload_url" ||
    kind === "lifecycle"
  ) {
    return "tool";
  }
  return "system";
}

function laneFor(category: TrajectoryCategory): 0 | 1 | 2 {
  if (category === "user") return 0;
  if (category === "result") return 2;
  return 1;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function buildTrajectoryTimeline(
  events: readonly ProtocolEvent[],
  exchanges: readonly HttpExchange[],
  mode: TrajectoryTimelineMode,
): TrajectoryTimeline {
  const exchangeById = new Map(exchanges.map((item) => [item.id, item]));
  const records = events
    .map((item) => {
      const exchange = exchangeById.get(item.exchangeId);
      const start = exchange?.startedAt ?? item.occurredAt;
      const end = Math.max(start, exchange?.completedAt ?? item.occurredAt);
      return { event: item, exchange, start, end };
    })
    .sort(
      (left, right) =>
        left.start - right.start ||
        left.event.occurredAt - right.event.occurredAt ||
        left.event.id.localeCompare(right.event.id),
    );

  if (records.length === 0) {
    return { start: 0, end: 0, durationMs: 0, spans: [] };
  }

  const actualStart = Math.min(...records.map((record) => record.start));
  const actualEnd = Math.max(...records.map((record) => record.end));
  const actualDuration = Math.max(1, actualEnd - actualStart);
  const denominator = mode === "time" ? actualDuration : records.length;

  const spans = records.map((record, index): TrajectorySpan => {
    const category = categoryForEvent(record.event.kind);
    const left =
      mode === "time"
        ? ((record.start - actualStart) / denominator) * 100
        : (index / denominator) * 100;
    const right =
      mode === "time"
        ? ((record.end - actualStart) / denominator) * 100
        : ((index + 0.72) / denominator) * 100;
    const safeLeft = clamp(left, 0, 100);
    const safeRight = clamp(Math.max(right, left), safeLeft, 100);

    return {
      event: record.event,
      category,
      lane: laneFor(category),
      leftPercent: safeLeft,
      rightPercent: safeRight,
      widthPercent: safeRight - safeLeft,
      durationMs: record.exchange?.durationMs ?? null,
    };
  });

  return {
    start: mode === "time" ? actualStart : 0,
    end: mode === "time" ? actualEnd : records.length,
    durationMs: mode === "time" ? actualEnd - actualStart : records.length,
    spans,
  };
}

function numericData(
  event: ProtocolEvent,
  key: "ret" | "errcode",
): number | null {
  const value = event.data[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function describeObservedOutcome(
  event: ProtocolEvent,
  exchange: HttpExchange | undefined,
): ObservedOutcome {
  if (exchange?.errorStage) {
    return {
      tone: "error",
      transport: `网络异常 · ${exchange.errorStage}`,
      business: "业务状态未知",
      delivery: "最终送达未知",
    };
  }

  const status = exchange?.responseStatus;
  const transport =
    status === null || status === undefined ? "HTTP 未知" : `HTTP ${status}`;
  if (status !== null && status !== undefined && status >= 400) {
    return {
      tone: "error",
      transport,
      business: "业务状态未知",
      delivery: "最终送达未知",
    };
  }

  const ret = numericData(event, "ret");
  const errcode = numericData(event, "errcode");
  const businessCode =
    ret !== null && ret !== 0
      ? ret
      : errcode !== null && errcode !== 0
        ? errcode
        : (ret ?? errcode);
  if (exchange?.responseTruncated)
    return {
      tone: "neutral",
      transport,
      business: "响应截断 · 业务状态未知",
      delivery: "最终送达未知",
    };
  if (businessCode !== null && businessCode !== 0) {
    return {
      tone: "warning",
      transport,
      business: `业务拒绝 · ${businessCode}`,
      delivery: "最终送达未知",
    };
  }

  return {
    tone: businessCode === 0 ? "success" : "neutral",
    transport,
    business: businessCode === 0 ? "业务已接受" : "业务状态未知",
    delivery: "最终送达未知",
  };
}
