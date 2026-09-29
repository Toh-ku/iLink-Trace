<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import type {
  ExchangeDetail,
  HttpExchange,
  Overview,
  ProtocolEvent,
  ReplayMode,
  ReplayRun,
} from "@ilink-trace/contracts";

const token = ref("");
const tokenInput = ref("");
const overview = ref<Overview | null>(null);
const events = ref<ProtocolEvent[]>([]);
const exchanges = ref<HttpExchange[]>([]);
const replays = ref<ReplayRun[]>([]);
const selectedExchange = ref<ExchangeDetail | null>(null);
const loading = ref(false);
const error = ref("");
const streamState = ref<"offline" | "connecting" | "live">("offline");
let stream: EventSource | null = null;
let refreshTimer: number | undefined;
let fallbackTimer: number | undefined;

const hasToken = computed(() => token.value.length > 0);
const recentEvents = computed(() => events.value.slice(0, 80));

function endpoint(path: string): string {
  return `/api/v1${path}`;
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
    "replay.updated",
    "recorder.degraded",
  ]) {
    stream.addEventListener(type, scheduleRefresh);
  }
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
  try {
    selectedExchange.value = await api<ExchangeDetail>(`/exchanges/${id}`);
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : "无法读取交换详情";
  }
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
    if (!response.ok)
      throw new Error(`导出失败：HTTP ${String(response.status)}`);
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
  }).format(value);
}

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function shortId(value: string | null): string {
  return value ? value.slice(0, 8) : "bootstrap";
}

onMounted(() => {
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
            <p class="eyebrow">iLink / ClawBot</p>
            <h1>Trace Console</h1>
          </div>
        </div>
        <div class="top-actions">
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

      <section class="hero">
        <div>
          <p class="eyebrow">OBSERVED FACTS, NOT GUESSES</p>
          <h2>本地协议链路一览</h2>
          <p>
            网络响应、业务接受与最终送达分别呈现；未接入 SDK 的处理区间标记为
            unobserved processing gap。
          </p>
        </div>
        <div class="hero-orbit" aria-hidden="true">
          <span>BOT</span><b /><span>TRACE</span><b /><span>iLINK</span>
        </div>
      </section>

      <section class="metrics">
        <article>
          <span>HTTP 交换</span>
          <strong>{{ overview?.exchanges ?? 0 }}</strong>
          <small>captured exchanges</small>
        </article>
        <article>
          <span>协议事件</span>
          <strong>{{ overview?.events ?? 0 }}</strong>
          <small>derived semantics</small>
        </article>
        <article>
          <span>入站 / 出站</span>
          <strong
            >{{ overview?.inboundMessages ?? 0 }}<em>/</em
            >{{ overview?.outboundMessages ?? 0 }}</strong
          >
          <small>message observations</small>
        </article>
        <article :class="{ warn: (overview?.failures ?? 0) > 0 }">
          <span>异常交换</span>
          <strong>{{ overview?.failures ?? 0 }}</strong>
          <small>network or HTTP failure</small>
        </article>
        <article class="accent-card">
          <span>活动重放</span>
          <strong>{{ overview?.activeReplays ?? 0 }}</strong>
          <small>isolated sandbox</small>
        </article>
      </section>

      <section class="workspace-grid">
        <article class="panel event-panel">
          <div class="panel-heading">
            <div>
              <p class="eyebrow">PROTOCOL TIMELINE</p>
              <h3>最新事件</h3>
            </div>
            <span>{{ recentEvents.length }} 条</span>
          </div>
          <div v-if="recentEvents.length" class="event-list">
            <div v-for="item in recentEvents" :key="item.id" class="event-row">
              <div class="event-rail">
                <i :class="`kind-${item.kind}`" />
              </div>
              <div class="event-main">
                <div class="event-meta">
                  <span class="event-kind">{{ item.kind }}</span>
                  <time>{{ formatTime(item.occurredAt) }}</time>
                </div>
                <strong>{{ item.summary }}</strong>
                <div class="event-tags">
                  <span>账号 {{ shortId(item.accountId) }}</span>
                  <span :class="`confidence-${item.confidence}`">
                    {{ item.confidence }}
                  </span>
                  <button
                    v-if="item.kind === 'inbound_message'"
                    class="text-button"
                    @click="startReplay(item.id)"
                  >
                    隔离重放
                  </button>
                </div>
              </div>
            </div>
          </div>
          <div v-else class="empty-state">等待 Bot 流量经过代理端口 8787</div>
        </article>

        <div class="right-stack">
          <article class="panel">
            <div class="panel-heading">
              <div>
                <p class="eyebrow">HTTP EXCHANGES</p>
                <h3>请求记录</h3>
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
                  >{{ exchange.responseStatus ?? "ERR" }}</span
                >
                <span class="duration">{{ exchange.durationMs }} ms</span>
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
                <h3>重放运行</h3>
              </div>
              <span>副作用已阻断</span>
            </div>
            <div class="replay-list">
              <div
                v-for="run in replays.slice(0, 8)"
                :key="run.id"
                class="replay-row"
              >
                <div>
                  <strong>{{ run.mode }} · {{ run.status }}</strong>
                  <small
                    >{{ formatTime(run.updatedAt) }} ·
                    {{ shortId(run.accountId) }}</small
                  >
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
                从入站消息事件启动安全重放
              </div>
            </div>
          </article>
        </div>
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
          <span>{{ selectedExchange.durationMs }} ms</span>
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
          <h4>响应 Body</h4>
          <pre>{{ selectedExchange.responseBody ?? "(empty)" }}</pre>
        </section>
      </aside>
    </div>
  </main>
</template>
