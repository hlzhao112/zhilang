import { database, tx } from './db.js';
import {
  cloneCell,
  decide,
  emptyCell,
  formatTime,
  pushStatus,
  type CellSnap,
  type Report,
  type Status,
} from './domain.js';
import { projects, boardCache, type LastReal, type TestMem } from './state.js';

export type ApplyResult = {
  accepted: true;
  status: Status;
  reason: string;
  projectId: number;
  sandbox: 0 | 1;
  version: number;
};

export type DeltaCell = {
  areaId: number;
  x: number;
  y: number;
  layers: number;
  unknown: boolean;
  issue: string;
  last: string | null;
  photos: CellSnap['photos'];
};

export type BatchNotice = {
  projectId: number;
  sandbox: 0 | 1;
  version: number;
  cells: DeltaCell[];
  test: TestMem;
  lastReal: LastReal;
};

type Planned = {
  report: Report;
  status: Status;
  reason: string;
  areaId: number | null;
  areaCode: string;
  areaName: string;
  before: number | null;
  after: number | null;
  receivedAt: string;
  recordSeen: boolean;
  push: boolean;
  next: CellSnap | null;
};

export function applyReports(reports: Report[]): { results: ApplyResult[]; notices: BatchNotice[] } {
  const scratch = new Map<string, CellSnap>();
  const scratchSeen = new Map<string, Set<string>>();
  const planned = reports.map((report) => planOne(report, scratch, scratchSeen));
  tx(() => {
    for (const item of planned) persist(item);
    persistAggregates(planned);
  });
  commitMemory(planned, scratch, scratchSeen);
  return { results: planned.map(toResult), notices: noticesOf(planned) };
}

function planOne(report: Report, scratch: Map<string, CellSnap>, scratchSeen: Map<string, Set<string>>): Planned {
  const receivedAt = formatTime();
  const base = {
    report,
    receivedAt,
    areaId: null as number | null,
    areaCode: '',
    areaName: '',
    before: null as number | null,
    after: null as number | null,
    recordSeen: false,
    push: false,
    next: null as CellSnap | null,
  };
  const project = projects.get(report.projectId);
  if (!project) return { ...base, status: '异常', reason: '项目不存在' };
  const area = project.devices.get(report.deviceId) ?? null;
  const located = locate(project.id, area, report, scratch);
  const decision = decide({
    eventId: report.eventId,
    duplicate: report.eventId.trim() ? seen(project.id, report, scratchSeen) : false,
    action: report.action,
    knownDevice: Boolean(area),
    cell: located,
    time: report.eventTime || receivedAt,
  });
  if (decision.recordSeen && report.eventId.trim()) {
    const key = `${report.projectId}:${report.sandbox}`;
    const set = scratchSeen.get(key) ?? new Set<string>();
    set.add(report.eventId);
    scratchSeen.set(key, set);
  }
  if (decision.next && area) scratch.set(cellKey(report, area.id), decision.next);
  return {
    ...base,
    status: decision.status,
    reason: decision.reason,
    areaId: area?.id ?? null,
    areaCode: area?.code ?? '',
    areaName: area?.name ?? '',
    before: decision.before,
    after: decision.after,
    recordSeen: decision.recordSeen,
    push: decision.push,
    next: decision.next,
  };
}

function locate(projectId: number, area: { id: number; rows: number; cols: number; matrix: number[][]; cells: [Map<string, CellSnap>, Map<string, CellSnap>] } | null, report: Report, scratch: Map<string, CellSnap>) {
  if (!area) return null;
  if (!Number.isInteger(report.x) || !Number.isInteger(report.y) || report.x < 1 || report.y < 1 || report.x > area.rows || report.y > area.cols) return null;
  if (area.matrix[report.x - 1][report.y - 1] !== 1) return { invalid: true, state: emptyCell() };
  const key = cellKey(report, area.id);
  const staged = scratch.get(key);
  if (staged) return { invalid: false, state: staged };
  const current = area.cells[report.sandbox].get(`${report.x}:${report.y}`);
  return { invalid: false, state: current ? cloneCell(current) : emptyCell() };
}

function seen(projectId: number, report: Report, scratchSeen: Map<string, Set<string>>): boolean {
  if (projects.get(projectId)?.seen[report.sandbox].has(report.eventId)) return true;
  return scratchSeen.get(`${projectId}:${report.sandbox}`)?.has(report.eventId) ?? false;
}

function persist(item: Planned): void {
  const { report } = item;
  database().prepare(`
    INSERT INTO raw_messages (project_id, sandbox, received_at, device_code, action, x, y, event_id, status, reason, payload_json, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    report.projectId, report.sandbox, item.receivedAt, report.deviceId, report.action, report.x, report.y,
    report.eventId, item.status, item.reason,
    JSON.stringify({
      eventId: report.eventId || null,
      deviceId: report.deviceId,
      action: report.action === '存梁' ? 'STORE' : 'TAKE',
      x: report.x,
      y: report.y,
      eventTime: report.eventTime,
      photo: null,
      source: report.source,
    }),
    report.source,
  );
  if (item.recordSeen && report.eventId) {
    database().prepare(`INSERT OR IGNORE INTO seen_ids (project_id, sandbox, event_id) VALUES (?, ?, ?)`).run(report.projectId, report.sandbox, report.eventId);
  }
  if (item.next && item.areaId) {
    database().prepare(`
      INSERT INTO cells (project_id, area_id, x, y, sandbox, layers, unknown, issue, last_event_at, photos_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id, area_id, x, y, sandbox) DO UPDATE SET
        layers=excluded.layers, unknown=excluded.unknown, issue=excluded.issue,
        last_event_at=excluded.last_event_at, photos_json=excluded.photos_json
    `).run(report.projectId, item.areaId, report.x, report.y, report.sandbox, item.next.layers, item.next.unknown ? 1 : 0, item.next.issue, item.next.last, JSON.stringify(item.next.photos));
  }
  if (item.push && item.areaId && item.before !== null && item.after !== null) {
    database().prepare(`
      INSERT INTO business_events (
        project_id, sandbox, event_id, event_time, area_code, area_name, x, y, action,
        before_layers, after_layers, device_code, source, push_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      report.projectId, report.sandbox, report.eventId, report.eventTime || item.receivedAt,
      item.areaCode, item.areaName, report.x, report.y, report.action, item.before, item.after,
      report.deviceId, report.source, pushStatus(report.source, projects.get(report.projectId)?.customer.endpoint ?? ''),
    );
  }
}

function persistAggregates(planned: Planned[]): void {
  const tests = new Map<number, { count: number; lastAt: string | null; lastAction: string }>();
  const reals = new Map<number, NonNullable<LastReal>>();
  for (const item of planned) {
    const project = projects.get(item.report.projectId);
    if (!project) continue;
    if (item.report.source === 'TEST') {
      const bucket = tests.get(project.id) ?? { count: project.test.count, lastAt: project.test.lastAt, lastAction: project.test.lastAction };
      bucket.count += 1;
      if (item.status === '已处理') {
        bucket.lastAt = item.report.eventTime || item.receivedAt;
        bucket.lastAction = `${item.report.action} · ${item.areaCode} · X${item.report.x} Y${item.report.y}`;
      }
      tests.set(project.id, bucket);
    }
    if (item.report.source === 'DEVICE' && item.status === '已处理') {
      reals.set(project.id, {
        time: item.report.eventTime || item.receivedAt,
        action: item.report.action,
        area: item.areaCode,
        x: item.report.x,
        y: item.report.y,
      });
    }
  }
  for (const [id, test] of tests) {
    database().prepare(`UPDATE test_state SET count=?, last_at=?, last_action=? WHERE project_id=?`).run(test.count, test.lastAt, test.lastAction, id);
  }
  for (const [id, real] of reals) {
    database().prepare(`UPDATE projects SET last_real_at=?, last_real_action=?, last_real_area=?, last_real_x=?, last_real_y=? WHERE id=?`).run(real.time, real.action, real.area, real.x, real.y, id);
  }
}

function commitMemory(planned: Planned[], scratch: Map<string, CellSnap>, scratchSeen: Map<string, Set<string>>): void {
  for (const [key, cell] of scratch) {
    const [projectId, areaId, sandbox, x, y] = key.split(':').map(Number);
    const project = projects.get(projectId);
    const area = project?.areas.find((item) => item.id === areaId);
    if (!area || (sandbox !== 0 && sandbox !== 1)) continue;
    area.cells[sandbox].set(`${x}:${y}`, cell);
  }
  for (const [key, ids] of scratchSeen) {
    const [projectId, sandbox] = key.split(':').map(Number);
    const project = projects.get(projectId);
    if (!project || (sandbox !== 0 && sandbox !== 1)) continue;
    for (const id of ids) project.seen[sandbox].add(id);
  }
  const bumped = new Set<string>();
  for (const item of planned) {
    const project = projects.get(item.report.projectId);
    if (!project) continue;
    const mark = `${project.id}:${item.report.sandbox}`;
    if (bumped.has(mark)) continue;
    bumped.add(mark);
    project.versions[item.report.sandbox] += 1;
    boardCache.delete(mark);
  }
  for (const item of planned) {
    const project = projects.get(item.report.projectId);
    if (!project || item.report.source !== 'TEST') continue;
    project.test.count += 1;
    if (item.status === '已处理') {
      project.test.lastAt = item.report.eventTime || item.receivedAt;
      project.test.lastAction = `${item.report.action} · ${item.areaCode} · X${item.report.x} Y${item.report.y}`;
    }
  }
  for (const item of planned) {
    const project = projects.get(item.report.projectId);
    if (!project || item.report.source !== 'DEVICE' || item.status !== '已处理') continue;
    project.lastReal = {
      time: item.report.eventTime || item.receivedAt,
      action: item.report.action,
      area: item.areaCode,
      x: item.report.x,
      y: item.report.y,
    };
  }
}

function noticesOf(planned: Planned[]): BatchNotice[] {
  const groups = new Map<string, BatchNotice>();
  for (const item of planned) {
    const project = projects.get(item.report.projectId);
    if (!project) continue;
    const key = `${project.id}:${item.report.sandbox}`;
    let notice = groups.get(key);
    if (!notice) {
      notice = { projectId: project.id, sandbox: item.report.sandbox, version: project.versions[item.report.sandbox], cells: [], test: { ...project.test }, lastReal: project.lastReal };
      groups.set(key, notice);
    }
    if (item.next && item.areaId) {
      notice.cells = notice.cells.filter((cell) => !(cell.areaId === item.areaId && cell.x === item.report.x && cell.y === item.report.y));
      notice.cells.push({ areaId: item.areaId, x: item.report.x, y: item.report.y, layers: item.next.layers, unknown: item.next.unknown, issue: item.next.issue, last: item.next.last, photos: item.next.photos });
    }
    notice.test = { ...project.test };
    notice.lastReal = project.lastReal;
  }
  return [...groups.values()];
}

function toResult(item: Planned): ApplyResult {
  return {
    accepted: true,
    status: item.status,
    reason: item.reason,
    projectId: item.report.projectId,
    sandbox: item.report.sandbox,
    version: projects.get(item.report.projectId)?.versions[item.report.sandbox] ?? 0,
  };
}

function cellKey(report: Report, areaId: number): string {
  return `${report.projectId}:${areaId}:${report.sandbox}:${report.x}:${report.y}`;
}
