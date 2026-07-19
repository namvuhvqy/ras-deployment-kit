import { createStoreFromEnv } from '../../../packages/shared/src/persistentStore.js';
import { createZernioAdapterFromEnv } from '../../../packages/zernio-adapter/src/index.js';
import { RasJobWorker, workerOptionsFromEnv } from '../../../packages/worker/src/jobWorker.js';

const store = createStoreFromEnv();
const adapter = createZernioAdapterFromEnv();
const worker = new RasJobWorker(store, adapter, workerOptionsFromEnv());

const controller = new AbortController();
process.on('SIGINT', () => controller.abort());
process.on('SIGTERM', () => controller.abort());

worker
  .runForever(controller.signal)
  .then(() => {
    console.log('ras-worker stopped');
  })
  .catch((error) => {
    console.error('ras-worker fatal', error);
    process.exitCode = 1;
  });
