<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import type {
  MessageTrace,
  TraceDetail,
  TraceSpan,
} from "@ilink-trace/contracts";
import {
  confidenceLabels,
  decodeTraceDetail,
  decodeTracePage,
  duration,
  outcomeLabel,
  replyLabels,
  virtualWindow,
} from "./message-traces";

const props = defineProps<{
  mode: "messages" | "traces";
  revision: number;
  request: (path: string, signal: AbortSignal) => Promise<unknown>;
}>();
const emit = defineEmits<{
  inspect: [id: string];
  replay: [eventId: string];
}>();
const url = new URL(window.location.href);
const accountId = ref(url.searchParams.get("account") ?? "");
const userId = ref(url.searchParams.get("user") ?? "");
const source = ref(url.searchParams.get("source") ?? "all");
const search = ref(url.searchParams.get("search") ?? "");
const items = ref<MessageTrace[]>([]);
const nextCursor = ref<string | null>(null);
const selectedId = ref<string | null>(url.searchParams.get("trace"));
const detail = ref<TraceDetail | null>(null);
const error = ref("");
const loading = ref(false);
const detailLoading = ref(false);
const scrollTop = ref(0);
const list = ref<HTMLElement | null>(null);
const listHeight = ref(600);
let listController: AbortController | null = null;
let detailController: AbortController | null = null;
let filterTimer: number | undefined;
let observer: ResizeObserver | null = null;
const windowRange = computed(() =>
  virtualWindow(items.value.length, scrollTop.value, listHeight.value, 108),
);
const visible = computed(() =>
  items.value.slice(windowRange.value.start, windowRange.value.end),
);
const replies = computed(
  () =>
    detail.value?.spans.filter(
      (item) => item.event.kind === "outbound_message",
    ) ?? [],
);
const calls = computed(() => detail.value?.spans ?? []);
const timingStart = computed(() =>
  Math.min(
    detail.value?.trace.startedAt ?? 0,
    ...calls.value.map((item) => item.exchange.startedAt),
  ),
);
const timingEnd = computed(() => detail.value?.trace.updatedAt ?? 0);
const timingWidth = computed(() =>
  Math.max(1, timingEnd.value - timingStart.value),
);
const kindLabel: Record<string, string> = {
  inbound_message: "用户消息",
  config: "获取配置",
  typing: "输入状态",
  outbound_message: "Bot 回复",
  upload_url: "上传元数据",
  lifecycle: "生命周期",
  protocol_error: "解析异常",
  poll: "轮询",
  qr_status: "登录状态",
};
function time(value: number): string {
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}
function short(value: string | null): string {
  return value ? value.slice(0, 12) : "未知";
}
function saveUrl(): void {
  const current = new URL(window.location.href);
  for (const [key, value] of [
    ["account", accountId.value],
    ["user", userId.value],
    ["source", source.value === "all" ? "" : source.value],
    ["search", search.value],
    ["trace", selectedId.value ?? ""],
  ]) {
    if (value) current.searchParams.set(key!, value);
    else current.searchParams.delete(key!);
  }
  window.history.replaceState({}, "", current);
}
async function load(append = false): Promise<void> {
  listController?.abort();
  const controller = new AbortController();
  listController = controller;
  loading.value = true;
  const query = new URLSearchParams({ limit: "50" });
  if (accountId.value) query.set("accountId", accountId.value);
  if (userId.value) query.set("userId", userId.value);
  if (source.value !== "all") query.set("source", source.value);
  if (search.value) query.set("search", search.value);
  if (append && nextCursor.value) query.set("cursor", nextCursor.value);
  try {
    const page = decodeTracePage(
      await props.request(`/traces?${query}`, controller.signal),
    );
    if (controller.signal.aborted) return;
    items.value = append
      ? [
          ...items.value,
          ...page.items.filter(
            (item) => !items.value.some((old) => old.id === item.id),
          ),
        ]
      : page.items;
    nextCursor.value = page.nextCursor;
    if (!append) {
      scrollTop.value = 0;
      if (list.value) list.value.scrollTop = 0;
    }
    if (!selectedId.value && page.items[0]) selectedId.value = page.items[0].id;
    if (selectedId.value && !append) await inspect(selectedId.value);
    error.value = "";
  } catch (reason) {
    if (!controller.signal.aborted)
      error.value = reason instanceof Error ? reason.message : "读取消息失败";
  } finally {
    if (listController === controller) loading.value = false;
  }
}
async function inspect(id: string, append = false): Promise<void> {
  detailController?.abort();
  const controller = new AbortController();
  detailController = controller;
  if (selectedId.value !== id) detail.value = null;
  selectedId.value = id;
  saveUrl();
  detailLoading.value = true;
  try {
    const offset = append ? (detail.value?.nextSpanOffset ?? 0) : 0;
    const result = decodeTraceDetail(
      await props.request(
        `/traces/${encodeURIComponent(id)}?spanOffset=${offset}`,
        controller.signal,
      ),
    );
    if (controller.signal.aborted) return;
    detail.value =
      append && detail.value
        ? { ...result, spans: [...detail.value.spans, ...result.spans] }
        : result;
  } catch (reason) {
    if (!controller.signal.aborted)
      error.value =
        reason instanceof Error ? reason.message : "读取 Trace 失败";
  } finally {
    if (detailController === controller) detailLoading.value = false;
  }
}
function timelineRect(span: TraceSpan) {
  return {
    x:
      140 +
      ((span.exchange.startedAt - timingStart.value) / timingWidth.value) * 700,
    width: Math.max(3, (span.exchange.durationMs / timingWidth.value) * 700),
  };
}
function lane(span: TraceSpan): number {
  return span.exchange.source === "replay"
    ? 3
    : span.event.kind === "inbound_message"
      ? 2
      : 0;
}
function tone(span: TraceSpan): string {
  return span.outcome.transport === "cancelled"
    ? "cancelled"
    : span.outcome.transport === "failed" || span.outcome.http === "failed"
      ? "failed"
      : span.outcome.business === "rejected"
        ? "rejected"
        : span.outcome.business === "accepted"
          ? "accepted"
          : "unknown";
}
watch([accountId, userId, source, search], () => {
  saveUrl();
  window.clearTimeout(filterTimer);
  filterTimer = window.setTimeout(() => {
    selectedId.value = null;
    detail.value = null;
    void load();
  }, 250);
});
watch(
  () => props.revision,
  () => {
    // Keep the user's history page and selection stable when new live traffic arrives.
    if (items.value.length <= 50 && scrollTop.value < 108) void load();
    else if (selectedId.value) void inspect(selectedId.value);
  },
);
onMounted(async () => {
  await nextTick();
  observer = new ResizeObserver((entries) => {
    listHeight.value = entries[0]?.contentRect.height ?? 600;
  });
  if (list.value) observer.observe(list.value);
  void load();
});
onUnmounted(() => {
  listController?.abort();
  detailController?.abort();
  observer?.disconnect();
  window.clearTimeout(filterTimer);
});
</script>

<template>
  <section class="message-workspace">
    <div class="message-filters">
      <label
        >账号指纹<input
          v-model="accountId"
          placeholder="全部账号"
          maxlength="100"
      /></label>
      <label
        >发送者指纹<input
          v-model="userId"
          placeholder="全部发送者"
          maxlength="100"
      /></label>
      <label
        >来源<select v-model="source">
          <option value="all">全部来源</option>
          <option value="live">Live</option>
          <option value="replay">Replay</option>
        </select></label
      >
      <label
        >查找消息<input
          v-model="search"
          placeholder="搜索已捕获正文"
          maxlength="100"
      /></label>
      <button class="ghost" :disabled="loading" @click="load()">
        {{ loading ? "加载中" : "刷新列表" }}
      </button>
    </div>
    <p v-if="error" class="error-banner" role="alert">{{ error }}</p>
    <div class="message-columns">
      <aside class="message-sidebar">
        <div class="panel-heading">
          <h3>{{ mode === "messages" ? "消息会话" : "消息 Traces" }}</h3>
          <span>{{ items.length }} 条已加载</span>
        </div>
        <div
          ref="list"
          class="virtual-message-list"
          @scroll="scrollTop = ($event.target as HTMLElement).scrollTop"
        >
          <div :style="{ height: `${windowRange.top}px` }" />
          <button
            v-for="item in visible"
            :key="item.id"
            class="message-list-row"
            :class="{ selected: selectedId === item.id }"
            @click="inspect(item.id)"
          >
            <span class="message-row-meta"
              >{{ short(item.accountId) }} / {{ short(item.userId) }}
              <b>{{ item.source }}</b></span
            >
            <strong>{{ item.inboundSummary }}</strong>
            <span
              >{{ time(item.startedAt) }} ·
              {{ duration(item.durationMs) }}</span
            >
            <small :class="`reply-${item.replyStatus}`"
              >{{ replyLabels[item.replyStatus] }} ·
              {{ confidenceLabels[item.confidence] }}</small
            >
          </button>
          <div :style="{ height: `${windowRange.bottom}px` }" />
          <div v-if="!items.length && !loading" class="empty-state">
            没有匹配的消息，等待 Bot 流量
          </div>
        </div>
        <button
          v-if="nextCursor"
          class="ghost wide"
          :disabled="loading"
          @click="load(true)"
        >
          加载更早消息
        </button>
      </aside>
      <article class="message-detail">
        <template v-if="detail">
          <header class="message-detail-header">
            <div>
              <p class="eyebrow">
                {{ mode === "messages" ? "CONVERSATION" : "MESSAGE TRACE" }}
              </p>
              <h3>
                账号 {{ short(detail.trace.accountId) }} · 发送者
                {{ short(detail.trace.userId) }}
              </h3>
            </div>
            <button
              class="ghost"
              @click="emit('replay', detail.trace.inboundEventId)"
            >
              隔离重放
            </button>
          </header>
          <div class="detail-facts">
            <span>{{ detail.trace.source }}</span
            ><span>{{ confidenceLabels[detail.trace.confidence] }}</span
            ><span>总耗时 {{ duration(detail.trace.durationMs) }}</span
            ><span>{{ detail.trace.spanCount }} 个 span</span
            ><span>{{ replyLabels[detail.trace.replyStatus] }}</span>
          </div>
          <p class="boundary-copy">
            总耗时从入站消息返回时开始计算。推断关联不代表确定事实；未关联或有歧义的调用仍可在事件账本中查看。
          </p>
          <div v-if="mode === 'messages'" class="chat-messages">
            <div class="chat-bubble inbound">
              <small
                >用户 · {{ time(detail.trace.startedAt) }} · 类型
                {{ detail.trace.messageType ?? "未知" }}</small
              >
              <p>
                {{ detail.trace.inboundText ?? detail.trace.inboundSummary }}
              </p>
              <span v-if="!detail.trace.inboundText"
                >正文未捕获或非文本消息</span
              ><button
                class="text-button"
                @click="
                  emit(
                    'inspect',
                    calls.find(
                      (item) => item.event.id === detail?.trace.inboundEventId,
                    )?.exchange.id ?? '',
                  )
                "
              >
                HTTP 详情
              </button>
            </div>
            <div
              v-for="reply in replies"
              :key="reply.event.id"
              class="chat-bubble outbound"
            >
              <small
                >Bot · {{ time(reply.event.occurredAt) }} ·
                {{ confidenceLabels[reply.confidence] }}</small
              >
              <p>{{ reply.event.data.text ?? reply.event.summary }}</p>
              <span>{{ outcomeLabel(reply.outcome) }}</span
              ><button
                class="text-button"
                @click="emit('inspect', reply.exchange.id)"
              >
                HTTP 详情
              </button>
            </div>
            <p v-if="!replies.length" class="empty-state compact">
              尚未观察到关联回复
            </p>
          </div>
          <section class="trace-timing">
            <h4>完整 Trace 时序 · {{ duration(timingWidth) }}</h4>
            <p class="boundary-copy">
              Bot / Trace / iLink / Replay Sandbox 泳道；矩形宽度表示已观察 HTTP
              持续时间。
            </p>
            <svg
              class="trace-swimlanes"
              viewBox="0 0 860 235"
              role="img"
              aria-label="消息 Trace 时序图"
            >
              <g
                v-for="(name, index) in [
                  'Bot',
                  'Trace',
                  'iLink',
                  'Replay Sandbox',
                ]"
                :key="name"
              >
                <text x="8" :y="42 + index * 48">{{ name }}</text>
                <line
                  x1="140"
                  x2="850"
                  :y1="38 + index * 48"
                  :y2="38 + index * 48"
                />
              </g>
              <g
                v-for="span in calls"
                :key="span.event.id"
                class="span-hit"
                role="button"
                tabindex="0"
                :aria-label="`${kindLabel[span.event.kind]} HTTP 详情`"
                @click="emit('inspect', span.exchange.id)"
                @keydown.enter="emit('inspect', span.exchange.id)"
                @keydown.space.prevent="emit('inspect', span.exchange.id)"
              >
                <title>
                  {{ kindLabel[span.event.kind] }} ·
                  {{ duration(span.exchange.durationMs) }} ·
                  {{ outcomeLabel(span.outcome) }}
                </title>
                <line
                  :x1="timelineRect(span).x"
                  :x2="timelineRect(span).x"
                  :y1="38 + lane(span) * 48"
                  y2="86"
                  class="trace-connector"
                />
                <rect
                  :x="timelineRect(span).x"
                  :y="28 + lane(span) * 48"
                  :width="timelineRect(span).width"
                  height="20"
                  rx="3"
                  :class="`span-${tone(span)}`"
                />
              </g>
              <text x="140" y="225">{{ time(timingStart) }}</text>
              <text x="850" y="225" text-anchor="end">
                {{ time(timingEnd) }}
              </text>
            </svg>
            <p
              v-for="gap in detail.trace.processingGaps"
              :key="gap.startedAt"
              class="processing-gap"
            >
              unobserved processing gap · {{ duration(gap.durationMs) }} ·
              {{ time(gap.startedAt) }}
            </p>
          </section>
          <section class="trace-span-list">
            <h4>协议调用与关联证据</h4>
            <button
              v-for="span in calls"
              :key="span.event.id"
              class="trace-call"
              @click="emit('inspect', span.exchange.id)"
            >
              <strong
                >{{ kindLabel[span.event.kind] }} ·
                {{ span.event.summary }}</strong
              ><code>{{ span.exchange.path }}</code
              ><span
                >{{ duration(span.exchange.durationMs) }} ·
                {{ confidenceLabels[span.confidence] }} ·
                {{ span.reason }}</span
              ><small>{{ outcomeLabel(span.outcome) }}</small
              ><small
                v-if="
                  span.exchange.requestTruncated ||
                  span.exchange.responseTruncated
                "
                >Payload 截断；转发字节不受影响</small
              >
            </button>
            <button
              v-if="detail.nextSpanOffset !== null"
              class="ghost wide"
              :disabled="detailLoading"
              @click="inspect(detail.trace.id, true)"
            >
              加载更多调用和回复
            </button>
          </section>
        </template>
        <div v-else class="empty-state">
          {{ detailLoading ? "加载 Trace 详情中" : "选择一条消息查看完整链路" }}
        </div>
      </article>
    </div>
  </section>
</template>
