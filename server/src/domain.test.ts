import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { decide, emptyCell, parseBoardSheet, parseMappingSheet } from './domain.js';
import { samplesDir } from './paths.js';
import { readFirstSheet } from './xlsx.js';

test('示例映射表按区域 ID 归并，并去掉表头空格', () => {
  const parsed = parseMappingSheet(readFirstSheet(readFileSync(join(samplesDir, 'mapping.xlsx'))));
  assert.ok(!('error' in parsed));
  if ('error' in parsed) return;
  assert.equal(parsed.areas.length, 2);
  assert.deepEqual(parsed.areas[0].devices.map((item) => item.code), ['BHb88888', 'BHb88887']);
  assert.equal(parsed.areas[1].devices[0].code, 'BHb88889');
  assert.equal(parsed.areas[0].name, 'xxxxx');
});

test('示例棋盘保留 0 格的位置', () => {
  const parsed = parseBoardSheet(readFirstSheet(readFileSync(join(samplesDir, 'area1.xlsx'))), '区域1', '区域1.xlsx');
  assert.ok(!('error' in parsed));
  if ('error' in parsed) return;
  assert.equal(parsed.rows, 5);
  assert.equal(parsed.cols, 5);
  assert.equal(parsed.matrix[4][3], 0);
  assert.equal(parsed.matrix[4][4], 0);
  assert.equal(parsed.matrix.flat().filter((bit) => bit === 1).length, 23);
});

test('同一位置最多堆到 3 层，空位不能取梁', () => {
  let state = emptyCell();
  for (let i = 0; i < 3; i++) {
    const decision = decide({ eventId: `S${i}`, duplicate: false, action: '存梁', knownDevice: true, cell: { invalid: false, state }, time: '2026-11-23 10:00:00' });
    assert.equal(decision.status, '已处理');
    assert.ok(decision.next);
    state = decision.next!;
  }
  assert.equal(state.layers, 3);
  const full = decide({ eventId: 'S3', duplicate: false, action: '存梁', knownDevice: true, cell: { invalid: false, state }, time: '2026-11-23 10:00:01' });
  assert.equal(full.status, '异常');
  assert.equal(full.next?.layers, 3);
  const taken = decide({ eventId: 'T1', duplicate: false, action: '取梁', knownDevice: true, cell: { invalid: false, state }, time: '2026-11-23 10:00:02' });
  assert.equal(taken.after, 2);
  assert.equal(taken.next?.photos.length, 2);
});
