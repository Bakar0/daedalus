export interface DomainEvent<T = unknown> {
  id: string;
  type: string;
  occurredAt: string;
  payload: T;
}

export type DomainEventListener = (event: DomainEvent) => void;

export class EventBus {
  readonly #listeners = new Set<DomainEventListener>();
  subscribe(listener: DomainEventListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  publish(event: DomainEvent): void {
    for (const listener of this.#listeners) listener(event);
  }
}
