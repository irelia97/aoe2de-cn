// Map-compatible LRU for disposable data. Never use for in-flight work or quotas.
export class BoundedCache extends Map {
  constructor(limit = 512) { super(); this.limit = limit; this.hits = 0; this.misses = 0; this.evictions = 0; }
  get(key) {
    if (!super.has(key)) { this.misses++; return undefined; }
    this.hits++;
    const value = super.get(key); super.delete(key); super.set(key, value); return value;
  }
  set(key, value) {
    super.delete(key); super.set(key, value);
    while (this.size > this.limit) { super.delete(this.keys().next().value); this.evictions++; }
    return this;
  }
  stats() { return { entries: this.size, limit: this.limit, hits: this.hits, misses: this.misses, evictions: this.evictions }; }
}
