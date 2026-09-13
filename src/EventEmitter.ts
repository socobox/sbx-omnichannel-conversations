// A tiny typed event emitter — @twilio/conversations' own Client/Conversation classes extend
// Node's EventEmitter (via a browser shim), exposing `.on()`/`.off()`/`.once()`/`.removeAllListeners()`.
// This reimplements just that surface, with no Node dependency, so the package works unmodified
// in a plain browser bundle (Vite, webpack, etc.) — the actual target runtime here.
export class TypedEventEmitter<Events extends Record<keyof Events, unknown[]>> {
  private listeners: { [K in keyof Events]?: Array<(...args: Events[K]) => void> } = {};

  on<K extends keyof Events>(event: K, listener: (...args: Events[K]) => void): this {
    (this.listeners[event] ??= []).push(listener);
    return this;
  }

  once<K extends keyof Events>(event: K, listener: (...args: Events[K]) => void): this {
    const wrapper = (...args: Events[K]) => {
      this.off(event, wrapper);
      listener(...args);
    };
    return this.on(event, wrapper);
  }

  off<K extends keyof Events>(event: K, listener: (...args: Events[K]) => void): this {
    const list = this.listeners[event];
    if (list) this.listeners[event] = list.filter((l) => l !== listener) as typeof list;
    return this;
  }

  removeAllListeners(event?: keyof Events): this {
    if (event) delete this.listeners[event];
    else this.listeners = {};
    return this;
  }

  protected emit<K extends keyof Events>(event: K, ...args: Events[K]): void {
    const list = this.listeners[event];
    if (!list) return;
    // Snapshot before iterating — a listener removing another listener (or itself, via once())
    // mid-emit must not skip or double-fire an unrelated one.
    for (const listener of [...list]) listener(...args);
  }
}
