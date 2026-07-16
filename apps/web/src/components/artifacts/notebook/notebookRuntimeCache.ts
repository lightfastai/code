export const NOTEBOOK_RUNTIME_CACHE_MAX_ENTRIES = 32;

export class NotebookRuntimeCache<Value> {
  readonly #entries = new Map<string, Value>();
  readonly #maxEntries: number;

  constructor(maxEntries = NOTEBOOK_RUNTIME_CACHE_MAX_ENTRIES) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
      throw new Error("Notebook runtime cache capacity must be a positive integer.");
    }
    this.#maxEntries = maxEntries;
  }

  get size(): number {
    return this.#entries.size;
  }

  get(key: string): Value | undefined {
    const value = this.#entries.get(key);
    if (value === undefined) return undefined;
    this.#entries.delete(key);
    this.#entries.set(key, value);
    return value;
  }

  set(key: string, value: Value): void {
    this.#entries.delete(key);
    this.#entries.set(key, value);
    while (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) return;
      this.#entries.delete(oldest);
    }
  }

  delete(key: string): boolean {
    return this.#entries.delete(key);
  }
}
