export type StorageOperation =
  | "initialize"
  | "recordExchange"
  | "listTraces"
  | "getTrace"
  | "listExchanges"
  | "getExchange"
  | "listEvents"
  | "getEvent"
  | "overview"
  | "createReplay"
  | "updateReplay"
  | "listReplays"
  | "close";

export interface StorageRequest {
  id: string;
  operation: StorageOperation;
  payload?: unknown;
}

export type StorageResponse =
  | { id: string; ok: true; result: unknown }
  | { id: string; ok: false; error: string };
