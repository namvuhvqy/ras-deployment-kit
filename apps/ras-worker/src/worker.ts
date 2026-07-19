import { FairProfileQueue } from '../../../packages/queue/src/fairQueue.js';
import type { RasJob } from '../../../packages/shared/src/types.js';

const queue = new FairProfileQueue();

const jobs: RasJob[] = [
  makeJob('a1', 'profile_A', 'P2'),
  makeJob('a2', 'profile_A', 'P2'),
  makeJob('b1', 'profile_B', 'P1'),
  makeJob('c1', 'profile_C', 'P3'),
];

for (const job of jobs) queue.enqueue(job);

const order: string[] = [];
while (queue.size() > 0) {
  const job = queue.dequeue();
  if (job) order.push(`${job.profileId}:${job.id}`);
}

console.log(JSON.stringify({ ok: true, worker: 'dry-run', order }, null, 2));

function makeJob(id: string, profileId: string, priority: RasJob['priority']): RasJob {
  return {
    id,
    profileId,
    priority,
    customerId: `customer_${profileId}`,
    type: 'publish_post',
    payload: {},
    status: 'queued',
    retryCount: 0,
    createdAtIso: new Date(0).toISOString(),
  };
}
