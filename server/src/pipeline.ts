import { applyReports, type ApplyResult } from './apply.js';
import { publish } from './hub.js';
import type { Report } from './domain.js';

type Job = { report: Report; resolve: (result: ApplyResult) => void };

const queue: Job[] = [];
let scheduled = false;
let processed = 0;
let dropped = 0;
const MAX = 20000;
const BATCH = 128;

export function enqueue(report: Report): Promise<ApplyResult> {
  if (queue.length >= MAX) {
    dropped += 1;
    return Promise.resolve({
      accepted: true,
      status: '异常',
      reason: '上报队列已满，请稍后重试',
      projectId: report.projectId,
      sandbox: report.sandbox,
      version: 0,
    });
  }
  return new Promise((resolve) => {
    queue.push({ report, resolve });
    if (!scheduled) {
      scheduled = true;
      setImmediate(flush);
    }
  });
}

export function ingestStats() {
  return { queued: queue.length, processed, dropped, batch: BATCH };
}

function flush(): void {
  scheduled = false;
  const batch = queue.splice(0, BATCH);
  if (!batch.length) return;
  try {
    const applied = applyReports(batch.map((job) => job.report));
    processed += batch.length;
    batch.forEach((job, index) => job.resolve(applied.results[index]));
    for (const notice of applied.notices) publish(notice.projectId, { type: 'delta', ...notice });
  } catch (error) {
    console.error('上报批次处理失败', error);
    for (const job of batch) {
      job.resolve({
        accepted: true,
        status: '异常',
        reason: '处理失败',
        projectId: job.report.projectId,
        sandbox: job.report.sandbox,
        version: 0,
      });
    }
  }
  if (queue.length) {
    scheduled = true;
    setImmediate(flush);
  }
}
