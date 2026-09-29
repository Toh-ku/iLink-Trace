import type { TraceEventNotification } from "@ilink-trace/contracts";

type Listener = (notification: TraceEventNotification) => void;

export class EventHub {
  readonly #history: TraceEventNotification[] = [];
  readonly #listeners = new Set<Listener>();
  #sequence = 0;

  publish(
    type: TraceEventNotification["type"],
    entityId: string,
  ): TraceEventNotification {
    const notification: TraceEventNotification = {
      id: ++this.#sequence,
      type,
      entityId,
      occurredAt: Date.now(),
    };
    this.#history.push(notification);
    if (this.#history.length > 256) this.#history.shift();
    for (const listener of this.#listeners) listener(notification);
    return notification;
  }

  since(id: number): TraceEventNotification[] {
    return this.#history.filter((notification) => notification.id > id);
  }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}
