export class Matchmaker {
  constructor(redis) {
    this.redis = redis;
    this.memory = [];
  }

  async enqueue(ticket) {
    if (!this.redis) return this.enqueueMemory(ticket);
    await this.redis.zadd(this.key(ticket), Date.now(), JSON.stringify(ticket));
    return this.findRedis(ticket);
  }

  async enqueueMemory(ticket) {
    const index = this.memory.findIndex((other) => other.mode === ticket.mode && other.region === ticket.region && other.player.id !== ticket.player.id && Math.abs(other.rating - ticket.rating) <= 250);
    if (index >= 0) return [this.memory.splice(index, 1)[0], ticket];
    this.memory.push(ticket);
    return null;
  }

  async findRedis(ticket) {
    const key = this.key(ticket);
    const raw = await this.redis.zrange(key, 0, 20);
    for (const item of raw) {
      const other = JSON.parse(item);
      if (other.player.id !== ticket.player.id && Math.abs(other.rating - ticket.rating) <= 250) {
        await this.redis.zrem(key, item, JSON.stringify(ticket));
        return [other, ticket];
      }
    }
    return null;
  }

  async cancel(ticket) {
    if (!this.redis) {
      this.memory = this.memory.filter((queued) => queued.player.id !== ticket.player.id);
      return;
    }
    await this.redis.zrem(this.key(ticket), JSON.stringify(ticket));
  }

  key(ticket) {
    return `matchmaking:${ticket.region}:${ticket.mode}`;
  }
}
