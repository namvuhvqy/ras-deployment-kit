import type { RasJob } from '../../shared/src/types.js';

export class FairProfileQueue {
  private readonly queues = new Map<string, RasJob[]>();
  private cursor = 0;

  enqueue(job: RasJob): void {
    const queue = this.queues.get(job.profileId) ?? [];
    queue.push(job);
    queue.sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority));
    this.queues.set(job.profileId, queue);
  }

  dequeue(): RasJob | undefined {
    const profiles = [...this.queues.keys()].filter((profileId) => (this.queues.get(profileId)?.length ?? 0) > 0);
    if (profiles.length === 0) return undefined;

    if (this.cursor >= profiles.length) this.cursor = 0;
    const profileId = profiles[this.cursor];
    this.cursor = (this.cursor + 1) % profiles.length;

    const queue = this.queues.get(profileId)!;
    const job = queue.shift();
    if (queue.length === 0) this.queues.delete(profileId);
    return job;
  }

  size(): number {
    return [...this.queues.values()].reduce((total, queue) => total + queue.length, 0);
  }
}

function priorityRank(priority: RasJob['priority']): number {
  if (typeof priority === 'number') return priority;
  return { P0: 0, P1: 1, P2: 2, P3: 3, P4: 4 }[priority] ?? 99;
}
