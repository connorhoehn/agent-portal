interface ReactionEvent { id: string; channel: string; timestamp: string; targetId?: unknown }

/** Live effects are events, not history. Keep the watermark above route mounts. */
export class CallReactionPlayback {
  private readonly channels = new Map<string, Set<string>>();
  take<T extends ReactionEvent>(events: readonly T[], now = Date.now()): T[] {
    const fresh: T[] = [];
    for (const event of events) {
      if (event.targetId) continue;
      let seen = this.channels.get(event.channel);
      if (!seen) {
        seen = new Set(); this.channels.set(event.channel, seen);
        if (this.channels.size > 16) this.channels.delete(this.channels.keys().next().value!);
      }
      if (seen.has(event.id)) continue;
      seen.add(event.id);
      if (seen.size > 256) seen.delete(seen.values().next().value!);
      const age = now - Date.parse(event.timestamp);
      if (Number.isFinite(age) && age >= -2000 && age < 10000) fresh.push(event);
    }
    return fresh;
  }
}
