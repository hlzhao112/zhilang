import { publish } from './hub.js';
import { enqueue } from './pipeline.js';
import { beginTest, getTest, planTestReport, projectExists, setTestNext, stopTest } from './repo.js';

const timers = new Map<number, NodeJS.Timeout>();
const starting = new Set<number>();

export function disarm(projectId: number): void {
  const timer = timers.get(projectId);
  if (timer) clearTimeout(timer);
  timers.delete(projectId);
}

export function arm(projectId: number): void {
  disarm(projectId);
  const test = getTest(projectId);
  if (!test?.running) return;
  const delay = Math.max(0, test.nextAt - Date.now());
  const timer = setTimeout(() => {
    timers.delete(projectId);
    void tick(projectId);
  }, delay);
  timers.set(projectId, timer);
}

export function parseInterval(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return 20;
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 600) return null;
  return number;
}

export async function startTest(projectId: number, actor: string, intervalSec: number): Promise<{ test: ReturnType<typeof getTest> } | { error: string }> {
  if (starting.has(projectId)) return { error: '测试正在开启' };
  starting.add(projectId);
  try {
    const begun = beginTest(projectId, actor, intervalSec);
    if ('error' in begun) return begun;
    const report = planTestReport(projectId);
    if (!report) {
      stopTest(projectId, actor, '没有可用位置');
      return { error: '没有可用的测试位置' };
    }
    await enqueue(report);
    arm(projectId);
    const test = getTest(projectId);
    if (test) publish(projectId, { type: 'reload', test });
    return { test };
  } finally {
    starting.delete(projectId);
  }
}

export function stopRunningTest(projectId: number, actor: string): { ok: true } | { error: string } {
  disarm(projectId);
  const stopped = stopTest(projectId, actor);
  const test = getTest(projectId);
  if (test) publish(projectId, { type: 'reload', test });
  return stopped;
}

async function tick(projectId: number): Promise<void> {
  if (!projectExists(projectId) || !getTest(projectId)?.running) return;
  const report = planTestReport(projectId);
  if (!report) {
    stopTest(projectId, '系统', '没有可用位置，测试已停止');
    publish(projectId, { type: 'reload', test: getTest(projectId) });
    return;
  }
  const intervalMs = (getTest(projectId)?.intervalSec ?? 20) * 1000;
  setTestNext(projectId, Date.now() + intervalMs);
  await enqueue(report);
  if (getTest(projectId)?.running) arm(projectId);
}
