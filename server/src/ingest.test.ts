import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { formatTime } from './domain.js';

process.env.YARD_DATA_DIR = mkdtempSync(join(tmpdir(), 'yard-'));

test('同一位置的并发存梁只会成功 3 次，且不会改到其他项目', async () => {
  const { initApp, cellLayers, listProjects } = await import('./repo.js');
  const { enqueue } = await import('./pipeline.js');
  initApp();
  const first = listProjects('').find((item) => item.code === 'LC001');
  const second = listProjects('').find((item) => item.code === 'LC002');
  assert.ok(first && second);
  const started = performance.now();
  const results = await Promise.all(Array.from({ length: 400 }, (_, index) => enqueue({
    projectId: first.id,
    sandbox: 0,
    source: 'MANUAL',
    eventId: `BULK-${index}`,
    deviceId: 'BHb88888',
    action: '存梁',
    x: 1,
    y: 1,
    eventTime: formatTime(),
  })));
  const ok = results.filter((item) => item.status === '已处理').length;
  assert.equal(ok, 3);
  assert.equal(cellLayers(first.id, 'BHb88888', 1, 1, 0), 3);
  assert.equal(results.filter((item) => item.status === '异常').length, 397);
  assert.equal(cellLayers(second.id, 'LM004', 1, 1, 0), 0);
  const again = await enqueue({
    projectId: first.id,
    sandbox: 0,
    source: 'MANUAL',
    eventId: 'BULK-0',
    deviceId: 'BHb88888',
    action: '存梁',
    x: 1,
    y: 2,
    eventTime: formatTime(),
  });
  assert.equal(again.status, '重复');
  assert.equal(cellLayers(first.id, 'BHb88888', 1, 2, 0), 0);
  const real = await enqueue({
    projectId: first.id,
    sandbox: 0,
    source: 'DEVICE',
    eventId: 'DEVICE-1',
    deviceId: 'BHb88888',
    action: '存梁',
    x: 1,
    y: 2,
    eventTime: formatTime(),
  });
  assert.equal(real.status, '已处理');
  assert.equal(listProjects('').find((item) => item.id === first.id)?.lastReal?.y, 2);
  console.log(`400 条同格上报耗时 ${Math.round(performance.now() - started)} ms`);
});
