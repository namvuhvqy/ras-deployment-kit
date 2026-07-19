import test from 'node:test';
import assert from 'node:assert/strict';
import { FairProfileQueue } from '../packages/queue/src/fairQueue.js';
import type { RasJob } from '../packages/shared/src/types.js';

test('FairProfileQueue rotates between profiles and respects per-profile priority', () => {
  const queue = new FairProfileQueue();
  queue.enqueue(makeJob('a-low', 'A', 'P4'));
  queue.enqueue(makeJob('a-high', 'A', 'P0'));
  queue.enqueue(makeJob('b-mid', 'B', 'P2'));

  assert.equal(queue.dequeue()?.id, 'a-high');
  assert.equal(queue.dequeue()?.id, 'b-mid');
  assert.equal(queue.dequeue()?.id, 'a-low');
  assert.equal(queue.dequeue(), undefined);
});

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
