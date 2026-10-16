/** Serialize replacements after an in-flight history page for the same chat. */
export class HistoryRequests {
  readonly #pending = new Map<number, Promise<void>>();
  run(chatId: number, work: () => Promise<void>): Promise<void> {
    const previous = this.#pending.get(chatId);
    if (previous) return previous;
    return this.replace(chatId, work);
  }
  replace(chatId: number, work: () => Promise<void>): Promise<void> {
    const previous = this.#pending.get(chatId);
    const task = (
      previous ? previous.catch(() => undefined) : Promise.resolve()
    )
      .then(work)
      .finally(() => {
        if (this.#pending.get(chatId) === task) this.#pending.delete(chatId);
      });
    this.#pending.set(chatId, task);
    return task;
  }
}
