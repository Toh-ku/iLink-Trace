<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from "vue";
import type {
  ExchangeDetail,
  HttpExchange,
  Overview,
  ProtocolEvent,
  ProtocolEventKind,
  ReplayMode,
  ReplayRun,
} from "@ilink-trace/contracts";
import {
  buildTrajectoryTimeline,
  categoryForEvent,
  describeObservedOutcome,
  TRAJECTORY_CATEGORY_META,
  type TrajectoryCategory,
  type TrajectoryTimelineMode,
} from "./trajectory";
import { nextTheme, resolveTheme, type Theme } from "./theme";
import MessageWorkspace from "./MessageWorkspace.vue";

type CategoryFilter = "all" | TrajectoryCategory;

const token = ref("");
const tokenInput = ref("");
const activePage = ref<"messages" | "traces" | "ledger">(
  new URL(window.location.href).searchParams.get("view") === "traces"
    ? "traces"
    : new URL(window.location.href).searchParams.get("view") === "ledger"
      ? "ledger"
      : "messages",
);
const revision = ref(0);
const recorderDegraded = ref(false);
const overview = ref<Overview | null>(null);
const events = ref<ProtocolEvent[]>([]);
const exchanges = ref<HttpExchange[]>([]);
const replays = ref<ReplayRun[]>([]);
const selectedExchange = ref<ExchangeDetail | null>(null);
const selectedEventId = ref<string | null>(null);
const categoryFilter = ref<CategoryFilter>("all");
const timelineMode = ref<TrajectoryTimelineMode>("time");
const theme = ref<Theme>(
  resolveTheme(
    localStorage.getItem("ilink-trace-theme"),
    window.matchMedia("(prefers-color-scheme: dark)").matches,
  ),
);
const loading = ref(false);
const error = ref("");
const streamState = ref<"offline" | "connecting" | "live">("offline");
let stream: EventSource | null = null;
let refreshTimer: number | undefined;
let fallbackTimer: number | undefined;

const hasToken = computed(() => token.value.length > 0);
const recentEvents = computed(() => events.value.slice(0, 120));
const exchangeById = computed(
  () => new Map(exchanges.value.map((item) => [item.id, item])),
);
const timeline = computed(() =>
  buildTrajectoryTimeline(
    recentEvents.value,
    exchanges.value,
    timelineMode.value,
  ),
);
const visibleSpans = computed(() =>
  timeline.value.spans.filter(
    (span) =>
      categoryFilter.value === "all" || span.category === categoryFilter.value,
  ),
);
const selectedEvent = computed(
  () => events.value.find((item) => item.id === selectedEventId.value) ?? null,
);
const selectedEventExchange = computed(() => {
  if (!selectedEvent.value) return undefined;
  return exchangeById.value.get(selectedEvent.value.exchangeId);
});
const selectedOutcome = computed(() => {
  if (!selectedEvent.value) return null;
  return describeObservedOutcome(
    selectedEvent.value,
    selectedEventExchange.value,
  );
});
const categoryFilters = computed(() => {
  const categories: CategoryFilter[] = [
    "all",
    "user",
    "result",
    "tool",
    "system",
    "error",
  ];
  return categories.map((category) => ({
    category,
    label:
      category === "all"
        ? "全部"
        : TRAJECTORY_CATEGORY_META[category].shortLabel,
    count:
      category === "all"
        ? timeline.value.spans.length
        : timeline.value.spans.filter((span) => span.category === category)
            .length,
  }));
});
const timelineTicks = computed(() => {
  const count = 5;
  return Array.from({ length: count }, (_, index) => {
    const ratio = index / (count - 1);
    if (timelineMode.value === "sequence") {
      const step = Math.round(
        ratio * Math.max(0, timeline.value.spans.length - 1),
      );
      return { position: ratio * 100, label: `#${String(step + 1)}` };
    }
    const value = timeline.value.start + timeline.value.durationMs * ratio;
    return { position: ratio * 100, label: formatTime(value) };
  });
});

const kindLabels: Record<ProtocolEventKind, string> = {
  qr_status: "QR 状态",
  poll: "长轮询",
  inbound_message: "用户消息",
  config: "获取配置",
  typing: "输入状态",
  outbound_message: "Bot 回复",
  upload_url: "媒体上传",
  lifecycle: "生命周期",
  protocol_error: "协议异常",
};

function endpoint(path: string): string {
  return `/api/v1${path}`;
}

function applyTheme(next: Theme): void {
  theme.value = next;
  document.documentElement.dataset.theme = next;
  localStorage.setItem("ilink-trace-theme", next);
}

function toggleTheme(): void {
  applyTheme(nextTheme(theme.value));
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("authorization", `Bearer ${token.value}`);
  if (init?.body) headers.set("content-type", "application/json");
  const response = await fetch(endpoint(path), { ...init, headers });
  if (!response.ok) {
    const detail = (await response.json().catch(() => null)) as {
      message?: string;
      error?: string;
    } | null;
    throw new Error(
      detail?.message ?? detail?.error ?? `HTTP ${String(response.status)}`,
    );
  }
  return (await response.json()) as T;
}

async function refresh(showSpinner = false): Promise<void> {
  if (!hasToken.value) return;
  if (showSpinner) loading.value = true;
  try {
    const [nextOverview, nextEvents, nextExchanges, nextReplays] =
      await Promise.all([
        api<Overview>("/overview"),
        api<ProtocolEvent[]>("/protocol-events?limit=200"),
        api<HttpExchange[]>("/exchanges?limit=100"),
        api<ReplayRun[]>("/replays"),
      ]);
    overview.value = nextOverview;
    events.value = nextEvents;
    exchanges.value = nextExchanges;
    replays.value = nextReplays;
    revision.value += 1;
    if (
      selectedEventId.value &&
      !nextEvents.some((item) => item.id === selectedEventId.value)
    ) {
      selectedEventId.value = null;
    }
    error.value = "";
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : "无法读取控制 API";
  } finally {
    loading.value = false;
  }
}

function scheduleRefresh(): void {
  window.clearTimeout(refreshTimer);
  refreshTimer = window.setTimeout(() => void refresh(), 150);
}

function connectStream(): void {
  stream?.close();
  if (!hasToken.value) return;
  streamState.value = "connecting";
  stream = new EventSource(
    `${endpoint("/events")}?access_token=${encodeURIComponent(token.value)}`,
  );
  stream.onopen = () => {
    streamState.value = "live";
  };
  stream.onerror = () => {
    streamState.value = "connecting";
  };
  for (const type of [
    "exchange.created",
    "protocol-event.created",
    "trace.created",
    "trace.updated",
    "replay.updated",
    "recorder.degraded",
  ]) {
    stream.addEventListener(type, scheduleRefresh);
  }
  stream.addEventListener("recorder.degraded", () => {
    recorderDegraded.value = true;
  });
  stream.onopen = () => {
    streamState.value = "live";
    scheduleRefresh();
  };
}

function changePage(page: "messages" | "traces" | "ledger"): void {
  activePage.value = page;
  const url = new URL(window.location.href);
  url.searchParams.set("view", page);
  window.history.replaceState({}, "", url);
}
function openTrace(id: string): void {
  const url = new URL(window.location.href);
  url.searchParams.set("trace", id);
  window.history.replaceState({}, "", url);
  changePage("traces");
}

async function traceRequest(
  path: string,
  signal: AbortSignal,
): Promise<unknown> {
  return api<unknown>(path, { signal });
}

function useToken(value = tokenInput.value): void {
  const next = value.trim();
  if (!next) return;
  token.value = next;
  tokenInput.value = "";
  sessionStorage.setItem("ilink-trace-token", next);
  connectStream();
  void refresh(true);
}

async function inspectExchange(id: string): Promise<void> {
  if (!id) return;
  try {
    selectedExchange.value = await api<ExchangeDetail>(`/exchanges/${id}`);
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : "无法读取交换详情";
  }
}

function selectEvent(id: string, scroll = false): void {
  selectedEventId.value = id;
  if (!scroll) return;
  void nextTick(() => {
    document
      .getElementById(`event-${id}`)
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
  });
}

async function startReplay(
  sourceEventId: string,
  mode: ReplayMode = "execution",
): Promise<void> {
  if (
    !window.confirm(
      "将为此账号启动隔离重放。所有出站副作用都会被阻断，继续吗？",
    )
  ) {
    return;
  }
  try {
    await api<ReplayRun>("/replays", {
      method: "POST",
      body: JSON.stringify({ sourceEventId, mode }),
    });
    await refresh();
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : "无法创建重放";
  }
}

async function cancelReplay(id: string): Promise<void> {
  try {
    await api<ReplayRun>(`/replays/${id}/cancel`, { method: "POST" });
    await refresh();
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : "无法取消重放";
  }
}

async function downloadExport(): Promise<void> {
  try {
    const response = await fetch(endpoint("/export"), {
      headers: { authorization: `Bearer ${token.value}` },
    });
    if (!response.ok) {
      throw new Error(`导出失败：HTTP ${String(response.status)}`);
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `ilink-trace-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : "无法导出";
  }
}

function formatTime(value: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
    hour12: false,
  }).format(value);
}

function formatDuration(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  if (value < 1_000) return `${String(Math.round(value))} ms`;
  return `${(value / 1_000).toFixed(value < 10_000 ? 2 : 1)} s`;
}

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function shortId(value: string | null): string {
  return value ? value.slice(0, 8) : "bootstrap";
}

function exchangeFor(event: ProtocolEvent): HttpExchange | undefined {
  return exchangeById.value.get(event.exchangeId);
}

function categoryLabel(event: ProtocolEvent): string {
  return TRAJECTORY_CATEGORY_META[categoryForEvent(event.kind)].label;
}

onMounted(() => {
  applyTheme(theme.value);
  const url = new URL(window.location.href);
  const supplied = url.searchParams.get("token");
  if (supplied) {
    url.searchParams.delete("token");
    window.history.replaceState({}, "", url);
  }
  const saved = supplied ?? sessionStorage.getItem("ilink-trace-token") ?? "";
  if (saved) useToken(saved);
  fallbackTimer = window.setInterval(() => void refresh(), 10_000);
});

onUnmounted(() => {
  stream?.close();
  window.clearInterval(fallbackTimer);
  window.clearTimeout(refreshTimer);
});
</script>

<template>
  <main class="app-shell">
    <button
      v-if="!hasToken"
      class="theme-toggle login-theme"
      :aria-label="theme === 'dark' ? '切换到白天主题' : '切换到黑夜主题'"
      :title="theme === 'dark' ? '切换到白天主题' : '切换到黑夜主题'"
      @click="toggleTheme"
    >
      <span aria-hidden="true">{{ theme === "dark" ? "☀" : "☾" }}</span>
      {{ theme === "dark" ? "白天" : "黑夜" }}
    </button>
    <section v-if="!hasToken" class="login-card">
      <div class="brand-mark">iT</div>
      <p class="eyebrow">LOCAL PROTOCOL OBSERVATORY</p>
      <h1>连接 iLink Trace</h1>
      <p class="muted">
        输入 daemon 启动时输出的一次性访问令牌。令牌只保存在当前浏览器会话中。
      </p>
      <form class="token-form" @submit.prevent="useToken()">
        <input
          v-model="tokenInput"
          type="password"
          autocomplete="off"
          placeholder="访问令牌"
          autofocus
        />
        <button class="primary" type="submit">连接控制台</button>
      </form>
    </section>

    <template v-else>
      <header class="topbar">
        <div class="brand">
          <div class="brand-mark small">iT</div>
          <div>
            <p class="eyebrow">iLink / ClawBot · LOCAL</p>
            <h1>Trace Console</h1>
          </div>
        </div>
        <div class="top-actions">
          <button
            class="theme-toggle"
            :aria-label="theme === 'dark' ? '切换到白天主题' : '切换到黑夜主题'"
            :title="theme === 'dark' ? '切换到白天主题' : '切换到黑夜主题'"
            @click="toggleTheme"
          >
            <span aria-hidden="true">{{ theme === "dark" ? "☀" : "☾" }}</span>
            {{ theme === "dark" ? "白天" : "黑夜" }}
          </button>
          <span class="connection" :class="streamState">
            <i />{{ streamState === "live" ? "实时连接" : "正在重连" }}
          </span>
          <button class="ghost" :disabled="loading" @click="refresh(true)">
            {{ loading ? "刷新中" : "刷新" }}
          </button>
          <button class="ghost" @click="downloadExport">导出 JSON</button>
        </div>
      </header>

      <div v-if="error" class="error-banner">
        <span>{{ error }}</span>
        <button @click="error = ''">关闭</button>
      </div>
      <p v-if="recorderDegraded" class="notice" role="alert">
        记录已降级，部分交换可能未保存。当前 Trace 可能不完整。
      </p>
      <nav class="page-tabs" aria-label="控制台页面">
        <button
          class="ghost"
          :class="{ active: activePage === 'messages' }"
          @click="changePage('messages')"
        >
          聊天式消息
        </button>
        <button
          class="ghost"
          :class="{ active: activePage === 'traces' }"
          @click="changePage('traces')"
        >
          完整 Trace
        </button>
        <button
          class="ghost"
          :class="{ active: activePage === 'ledger' }"
          @click="changePage('ledger')"
        >
          事件账本
        </button>
      </nav>

      <section class="page-heading">
        <div>
          <p class="eyebrow">TRAJECTORY</p>
          <h2>
            {{
              activePage === "messages"
                ? "消息与回复"
                : activePage === "traces"
                  ? "完整消息 Trace"
                  : "消息轨迹"
            }}
          </h2>
          <p>
            以事件账本还原用户输入、协议调用与 Bot
            返回；时间仅代表代理实际观察到的网络事实。
          </p>
        </div>
        <div class="scope-note">
          <span>可观测边界</span>
          <strong>iLink HTTP</strong>
          <small>内部处理标记为 unobserved</small>
        </div>
      </section>

      <section class="metrics" aria-label="轨迹统计">
        <article>
          <span>HTTP 交换</span>
          <strong>{{ overview?.exchanges ?? 0 }}</strong>
        </article>
        <article>
          <span>协议事件</span>
          <strong>{{ overview?.events ?? 0 }}</strong>
        </article>
        <article>
          <span>用户输入</span>
          <strong>{{ overview?.inboundMessages ?? 0 }}</strong>
        </article>
        <article>
          <span>返回结果</span>
          <strong>{{ overview?.outboundMessages ?? 0 }}</strong>
        </article>
        <article :class="{ warn: (overview?.failures ?? 0) > 0 }">
          <span>异常</span>
          <strong>{{ overview?.failures ?? 0 }}</strong>
        </article>
        <article class="accent-card">
          <span>活动重放</span>
          <strong>{{ overview?.activeReplays ?? 0 }}</strong>
        </article>
      </section>

      <MessageWorkspace
        v-if="activePage !== 'ledger'"
        :mode="activePage"
        :revision="revision"
        :request="traceRequest"
        @inspect="inspectExchange"
        @replay="startReplay"
      />
      <section v-else class="trajectory-shell">
        <div class="trajectory-main">
          <div class="trajectory-toolbar">
            <div>
              <p class="eyebrow">TIMING OVERVIEW</p>
              <h3>执行时间轴</h3>
            </div>
            <div class="mode-switch" aria-label="时间轴模式">
              <button
                :class="{ active: timelineMode === 'time' }"
                @click="timelineMode = 'time'"
              >
                实际时间
              </button>
              <button
                :class="{ active: timelineMode === 'sequence' }"
                @click="timelineMode = 'sequence'"
              >
                事件序列
              </button>
            </div>
          </div>

          <div v-if="timeline.spans.length" class="timeline-overview">
            <div class="timeline-labels" aria-hidden="true">
              <span>用户</span>
              <span>调用</span>
              <span>结果</span>
            </div>
            <div class="timeline-plot">
              <div
                v-for="tick in timelineTicks"
                :key="tick.position"
                class="timeline-gridline"
                :style="{ left: `${tick.position}%` }"
              />
              <div v-for="lane in [0, 1, 2]" :key="lane" class="timeline-lane">
                <button
                  v-for="span in timeline.spans.filter(
                    (item) => item.lane === lane,
                  )"
                  :key="span.event.id"
                  class="timeline-span"
                  :class="[
                    `category-${span.category}`,
                    {
                      selected: selectedEventId === span.event.id,
                      dimmed:
                        categoryFilter !== 'all' &&
                        categoryFilter !== span.category,
                    },
                  ]"
                  :style="{
                    left: `${span.leftPercent}%`,
                    width: `${Math.max(span.widthPercent, 0.8)}%`,
                  }"
                  :title="`${categoryLabel(span.event)} · ${span.event.summary} · ${formatDuration(span.durationMs)}`"
                  @click="selectEvent(span.event.id, true)"
                />
              </div>
              <div class="timeline-axis" aria-hidden="true">
                <span
                  v-for="tick in timelineTicks"
                  :key="tick.label"
                  :style="{ left: `${tick.position}%` }"
                >
                  {{ tick.label }}
                </span>
              </div>
            </div>
          </div>
          <div v-else class="empty-state timeline-empty">
            等待 Bot 流量经过代理端口 8787
          </div>

          <div class="ledger-heading">
            <div>
              <p class="eyebrow">EVENT LEDGER</p>
              <h3>事件账本</h3>
            </div>
            <div class="filter-tabs" aria-label="事件分类">
              <button
                v-for="filter in categoryFilters"
                :key="filter.category"
                :class="[
                  filter.category === 'all'
                    ? 'category-all'
                    : `category-${filter.category}`,
                  { active: categoryFilter === filter.category },
                ]"
                @click="categoryFilter = filter.category"
              >
                {{ filter.label }} <span>{{ filter.count }}</span>
              </button>
            </div>
          </div>

          <div v-if="visibleSpans.length" class="event-ledger">
            <article
              v-for="(span, index) in visibleSpans"
              :id="`event-${span.event.id}`"
              :key="span.event.id"
              class="ledger-record"
              :class="[
                `category-${span.category}`,
                { selected: selectedEventId === span.event.id },
              ]"
              @click="selectEvent(span.event.id)"
            >
              <div class="record-index">
                <span>{{ String(index + 1).padStart(2, "0") }}</span>
                <i />
              </div>
              <div class="record-card">
                <header>
                  <div class="record-role">
                    <span class="role-badge">
                      {{ TRAJECTORY_CATEGORY_META[span.category].label }}
                    </span>
                    <span class="kind-label">{{
                      kindLabels[span.event.kind]
                    }}</span>
                  </div>
                  <div class="record-time">
                    <span>{{ formatTime(span.event.occurredAt) }}</span>
                    <b>{{ formatDuration(span.durationMs) }}</b>
                  </div>
                </header>
                <p class="record-summary">{{ span.event.summary }}</p>

                <div v-if="exchangeFor(span.event)" class="call-strip">
                  <span class="method">{{
                    exchangeFor(span.event)?.method
                  }}</span>
                  <code>{{ exchangeFor(span.event)?.path }}</code>
                  <span
                    class="http-status"
                    :class="{
                      failed:
                        (exchangeFor(span.event)?.responseStatus ?? 500) >= 400,
                    }"
                  >
                    {{ exchangeFor(span.event)?.responseStatus ?? "ERR" }}
                  </span>
                </div>

                <footer>
                  <span>账号 {{ shortId(span.event.accountId) }}</span>
                  <span :class="`confidence-${span.event.confidence}`">
                    {{ span.event.confidence }}
                  </span>
                  <span
                    v-if="exchangeFor(span.event)?.source === 'replay'"
                    class="replay-chip"
                  >
                    replay
                  </span>
                  <span v-if="span.category === 'result'" class="delivery-chip">
                    最终送达未知
                  </span>
                  <button
                    v-if="span.event.kind === 'inbound_message'"
                    class="text-button"
                    @click.stop="startReplay(span.event.id)"
                  >
                    隔离重放
                  </button>
                  <button
                    class="text-button detail-link"
                    @click.stop="inspectExchange(span.event.exchangeId)"
                  >
                    HTTP 详情
                  </button>
                </footer>
              </div>
            </article>
          </div>
          <div v-else class="empty-state ledger-empty">当前筛选下没有事件</div>
        </div>

        <aside class="inspector">
          <template v-if="selectedEvent">
            <div class="inspector-heading">
              <div
                class="inspector-icon"
                :class="`category-${categoryForEvent(selectedEvent.kind)}`"
              >
                {{
                  TRAJECTORY_CATEGORY_META[categoryForEvent(selectedEvent.kind)]
                    .shortLabel
                }}
              </div>
              <div>
                <p class="eyebrow">RECORD INSPECTOR</p>
                <h3>{{ kindLabels[selectedEvent.kind] }}</h3>
              </div>
            </div>
            <p class="inspector-summary">{{ selectedEvent.summary }}</p>

            <section class="inspector-section">
              <h4>观测结论</h4>
              <div v-if="selectedOutcome" class="outcome-grid">
                <span :class="`tone-${selectedOutcome.tone}`">
                  {{ selectedOutcome.transport }}
                </span>
                <span :class="`tone-${selectedOutcome.tone}`">
                  {{ selectedOutcome.business }}
                </span>
                <span class="tone-neutral">{{ selectedOutcome.delivery }}</span>
              </div>
              <p class="boundary-copy">
                HTTP 成功、业务接受与最终送达是三个不同结论。
              </p>
            </section>

            <section class="inspector-section">
              <h4>Timing</h4>
              <dl class="fact-list">
                <div>
                  <dt>发生时间</dt>
                  <dd>{{ formatTime(selectedEvent.occurredAt) }}</dd>
                </div>
                <div>
                  <dt>网络耗时</dt>
                  <dd>
                    {{ formatDuration(selectedEventExchange?.durationMs) }}
                  </dd>
                </div>
                <div>
                  <dt>关联可信度</dt>
                  <dd>{{ selectedEvent.confidence }}</dd>
                </div>
                <div>
                  <dt>账号</dt>
                  <dd>{{ shortId(selectedEvent.accountId) }}</dd>
                </div>
              </dl>
            </section>

            <section class="inspector-section">
              <h4>Trace 关联证据</h4>
              <p class="boundary-copy">
                {{ selectedEvent.correlationReason ?? "unlinked" }} ·
                {{ selectedEvent.confidence }}
              </p>
              <button
                v-if="selectedEvent.traceId"
                class="text-button"
                @click="openTrace(selectedEvent.traceId)"
              >
                打开关联 Trace
              </button>
              <button
                v-for="id in selectedEvent.candidateTraceIds ?? []"
                :key="id"
                class="ghost wide"
                @click="openTrace(id)"
              >
                候选 Trace {{ shortId(id) }}
              </button>
            </section>
            <section class="inspector-section">
              <h4>记录数据（已脱敏）</h4>
              <pre>{{ formatJson(selectedEvent.data) }}</pre>
            </section>

            <div class="inspector-actions">
              <button
                class="ghost wide"
                @click="inspectExchange(selectedEvent.exchangeId)"
              >
                打开完整 HTTP 交换
              </button>
              <button
                v-if="selectedEvent.kind === 'inbound_message'"
                class="primary wide"
                @click="startReplay(selectedEvent.id)"
              >
                在沙箱中重放
              </button>
            </div>
          </template>
          <div v-else class="inspector-placeholder">
            <span>⌁</span>
            <strong>选择一条记录</strong>
            <p>点击时间轴区块或事件卡片，查看耗时、关联信息与脱敏数据。</p>
          </div>
        </aside>
      </section>

      <section class="utility-grid">
        <article class="panel">
          <div class="panel-heading">
            <div>
              <p class="eyebrow">HTTP EXCHANGES</p>
              <h3>原始交换</h3>
            </div>
            <span>{{ exchanges.length }} 条</span>
          </div>
          <div class="exchange-table">
            <button
              v-for="exchange in exchanges.slice(0, 40)"
              :key="exchange.id"
              class="exchange-row"
              @click="inspectExchange(exchange.id)"
            >
              <span class="method">{{ exchange.method }}</span>
              <span class="path">{{ exchange.path }}</span>
              <span
                class="status"
                :class="{ failed: (exchange.responseStatus ?? 500) >= 400 }"
              >
                {{ exchange.responseStatus ?? "ERR" }}
              </span>
              <span class="duration">{{
                formatDuration(exchange.durationMs)
              }}</span>
            </button>
            <div v-if="!exchanges.length" class="empty-state compact">
              暂无交换
            </div>
          </div>
        </article>

        <article class="panel">
          <div class="panel-heading">
            <div>
              <p class="eyebrow">REPLAY SANDBOX</p>
              <h3>隔离重放</h3>
            </div>
            <span>副作用已阻断</span>
          </div>
          <div class="replay-list">
            <div
              v-for="run in replays.slice(0, 8)"
              :key="run.id"
              class="replay-row"
            >
              <div class="replay-status-dot" :class="`status-${run.status}`" />
              <div>
                <strong>{{ run.mode }} · {{ run.status }}</strong>
                <small>
                  {{ formatTime(run.updatedAt) }} · {{ shortId(run.accountId) }}
                </small>
              </div>
              <button
                v-if="
                  ['queued', 'sandbox', 'draining', 'failed'].includes(
                    run.status,
                  )
                "
                class="text-button danger"
                @click="cancelReplay(run.id)"
              >
                取消
              </button>
            </div>
            <div v-if="!replays.length" class="empty-state compact">
              从用户输入记录启动安全重放
            </div>
          </div>
        </article>
      </section>
    </template>

    <div
      v-if="selectedExchange"
      class="drawer-backdrop"
      @click.self="selectedExchange = null"
    >
      <aside class="detail-drawer">
        <div class="drawer-heading">
          <div>
            <p class="eyebrow">EXCHANGE DETAIL</p>
            <h3>{{ selectedExchange.method }} {{ selectedExchange.path }}</h3>
          </div>
          <button class="close-button" @click="selectedExchange = null">
            ×
          </button>
        </div>
        <div class="detail-facts">
          <span>HTTP {{ selectedExchange.responseStatus ?? "ERROR" }}</span>
          <span>{{ formatDuration(selectedExchange.durationMs) }}</span>
          <span>{{ selectedExchange.source }}</span>
          <span>{{ shortId(selectedExchange.accountId) }}</span>
        </div>
        <p
          v-if="
            selectedExchange.requestTruncated ||
            selectedExchange.responseTruncated
          "
          class="notice"
        >
          Payload 已按捕获上限截断；转发字节不受影响。
        </p>
        <section>
          <h4>解析事件</h4>
          <div
            v-for="item in selectedExchange.events"
            :key="item.id"
            class="derived-event"
          >
            <strong>{{ item.summary }}</strong>
            <span>{{ item.kind }} · {{ item.confidence }}</span>
          </div>
        </section>
        <section>
          <h4>请求 Headers（已脱敏）</h4>
          <pre>{{ formatJson(selectedExchange.requestHeaders) }}</pre>
        </section>
        <section>
          <h4>请求 Body</h4>
          <pre>{{ selectedExchange.requestBody ?? "(empty)" }}</pre>
        </section>
        <section>
          <h4>响应 Headers（已脱敏）</h4>
          <pre>{{ formatJson(selectedExchange.responseHeaders) }}</pre>
        </section>
        <section v-if="selectedExchange.errorStage">
          <h4>网络错误阶段</h4>
          <p class="notice">{{ selectedExchange.errorStage }}</p>
        </section>
        <section>
          <h4>响应 Body</h4>
          <pre>{{ selectedExchange.responseBody ?? "(empty)" }}</pre>
        </section>
      </aside>
    </div>
  </main>
</template>
