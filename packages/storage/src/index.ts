import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import type {
  ExchangeDetail,
  HttpExchange,
  Overview,
  ProtocolEvent,
  ReplayRun,
  TracePage,
  TraceDetail,
  TraceListQuery,
} from "@ilink-trace/contracts";
import type { StorageRequest, StorageResponse } from "./worker-contract.js";

export const STORAGE_API_VERSION = 1;

export interface StorageClient {
  recordExchange(
    exchange: HttpExchange,
    events: ProtocolEvent[],
  ): Promise<Array<{ id: string; created: boolean }>>;
  listTraces(query?: TraceListQuery): Promise<TracePage>;
  getTrace(id: string, spanOffset?: number): Promise<TraceDetail | null>;
  listExchanges(limit?: number): Promise<HttpExchange[]>;
  getExchange(id: string): Promise<ExchangeDetail | null>;
  listEvents(limit?: number): Promise<ProtocolEvent[]>;
  getEvent(id: string): Promise<ProtocolEvent | null>;
  overview(): Promise<Overview>;
  createReplay(replay: ReplayRun): Promise<void>;
  updateReplay(replay: ReplayRun): Promise<void>;
  listReplays(): Promise<ReplayRun[]>;
  close(): Promise<void>;
}

interface PendingCall {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

export async function createStorageClient(
  databasePath: string,
): Promise<StorageClient> {
  const worker = new Worker(new URL("./worker.js", import.meta.url), {
    workerData: { databasePath },
    execArgv: process.execArgv.filter(
      (argument) => !argument.startsWith("--input-type"),
    ),
  });
  const pending = new Map<string, PendingCall>();

  worker.on("message", (response: StorageResponse) => {
    const pendingCall = pending.get(response.id);
    if (!pendingCall) return;
    pending.delete(response.id);
    if (response.ok) pendingCall.resolve(response.result);
    else pendingCall.reject(new Error(response.error));
  });
  worker.on("error", (error: Error) => {
    for (const pendingCall of pending.values()) pendingCall.reject(error);
    pending.clear();
  });

  const call = <T>(
    operation: StorageRequest["operation"],
    payload?: unknown,
  ): Promise<T> => {
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
      worker.postMessage({ id, operation, payload } satisfies StorageRequest);
    });
  };

  try {
    await call("initialize");
  } catch (error) {
    await worker.terminate();
    throw error;
  }

  return {
    recordExchange: async (exchange, events) =>
      call("recordExchange", { exchange, events }),
    listTraces: async (query = {}) => call("listTraces", query),
    getTrace: async (id, spanOffset = 0) =>
      call("getTrace", { id, spanOffset }),
    listExchanges: async (limit = 100) => call("listExchanges", { limit }),
    getExchange: async (id) => call("getExchange", { id }),
    listEvents: async (limit = 200) => call("listEvents", { limit }),
    getEvent: async (id) => call("getEvent", { id }),
    overview: async () => call("overview"),
    createReplay: async (replay) => call("createReplay", { replay }),
    updateReplay: async (replay) => call("updateReplay", { replay }),
    listReplays: async () => call("listReplays"),
    close: async () => {
      await call("close");
      await worker.terminate();
    },
  };
}
