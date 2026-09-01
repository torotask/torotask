import { isToroTaskDataRef } from 'torotask';
import { logger, server } from './server.js';

export * from './helpers.js';

async function main() {
  await server.start();

  logger.info('Running dataStoreTest (large payload + child return value + large parent return)...');

  const task = server.taskGroups.exampleGroup.tasks.dataStoreTest;
  const job = await task.run({ repeat: 1 });
  await job.waitUntilFinished(task.queue.queueEvents);
  const result = await job.getResult();

  logger.info({ jobId: job.id, result }, 'dataStoreTest handler result (hydrated)');

  if (job.id) {
    const parentQueue = 'exampleGroup.dataStoreTest';
    const rawJob = await server.redis.hget(
      `${server.queuePrefix}:${parentQueue}:${job.id}`,
      'data',
    );
    const rawReturn = await server.redis.hget(
      `${server.queuePrefix}:${parentQueue}:${job.id}`,
      'returnvalue',
    );

    logger.info({
      parentJobId: job.id,
      payloadInJobDataIsRef: rawJob ? rawJob.includes('"_torotaskDataRef"') : false,
      returnValueInJobHashIsRef: rawReturn ? rawReturn.includes('"_torotaskDataRef"') : false,
      hydratedReturnIsRef: isToroTaskDataRef(job.returnvalue),
    }, 'dataStoreTest Redis verification (refs expected in raw job hash)');

    const dataKeys = await server.redis.keys(`${server.prefix}:data:*`);
    logger.info({
      externalDataKeyCount: dataKeys.length,
      sampleKeys: dataKeys.slice(0, 8),
    }, 'External data keys in Redis — inspect with GET <key> (binary if compressed)');

    const stepStateKey = `${server.prefix}:state:${parentQueue}:${job.id}`;
    const stepFields = await server.redis.hgetall(stepStateKey);
    const stepFieldNames = Object.keys(stepFields);
    logger.info({
      stepStateKey,
      stepFieldCount: stepFieldNames.length,
      stepFieldNames,
      stepDataContainsRef: stepFieldNames.some(
        name => stepFields[name]?.includes('"_torotaskDataRef"'),
      ),
    }, 'Step state hash (torotask:state:...) — step result data may be refs when dataStore is on');
  }

  setInterval(() => {}, 1000 * 60 * 5);
}

main().catch(err => logger.error({ err }, 'Application error'));
