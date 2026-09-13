// Mirrors @twilio/conversations' own `Paginator<T>` shape exactly — `items`, `hasNextPage`/
// `hasPrevPage`, `nextPage()`/`prevPage()`. zavu's REST layer doesn't paginate message history at
// all (`GET /chats/:id` returns every message in one response) — Conversation fetches the full
// list once, caches it, and this class just slices that cache. Fine for a chat's realistic
// message volume; would need a real backend cursor for very long-lived conversations, flagged
// in the README as a known v1 limitation.
export class Paginator<T> {
  readonly items: T[];
  readonly hasNextPage: boolean;
  readonly hasPrevPage: boolean;

  private readonly all: T[];
  private readonly startIndex: number;
  private readonly pageSize: number;

  /** @internal */
  constructor(all: T[], startIndex: number, pageSize: number) {
    this.all = all;
    this.startIndex = startIndex;
    this.pageSize = pageSize;
    this.items = all.slice(startIndex, startIndex + pageSize);
    this.hasPrevPage = startIndex > 0;
    this.hasNextPage = startIndex + pageSize < all.length;
  }

  async prevPage(): Promise<Paginator<T>> {
    const newStart = Math.max(0, this.startIndex - this.pageSize);
    return new Paginator(this.all, newStart, this.pageSize);
  }

  async nextPage(): Promise<Paginator<T>> {
    const newStart = this.startIndex + this.pageSize;
    return new Paginator(this.all, newStart, this.pageSize);
  }
}
