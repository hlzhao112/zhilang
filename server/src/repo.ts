import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hashPassword, seal } from './crypto.js';
import { database, openDatabase } from './db.js';
import { tx } from './db.js';
import {
  cloneCell,
  countMatrix,
  emptyCell,
  formatTime,
  parseBoardSheet,
  parseMappingSheet,
  type AreaInput,
  type CellSnap,
  type CustomerInput,
  type MqttInput,
  type ProjectInput,
  type Retention,
} from './domain.js';
import { samplesDir } from './paths.js';
import { boardCache, dropBoard, projects, type AreaMem, type LastReal, type ProjectMem, type TestMem } from './state.js';
import { readFirstSheet } from './xlsx.js';

export type Card = {
  id: number;
  code: string;
  name: string;
  note: string;
  areaCount: number;
  deviceCount: number;
  validCount: number;
  testRunning: boolean;
  lastReal: LastReal;
  lastTest: { time: string; action: string } | null;
};

let inited = false;

export function initApp(): void {
  if (inited) return;
  inited = true;
  openDatabase();
  ensureAdmin();
  loadAll();
  if (projects.size === 0) seedSamples();
  recoverTests();
  const timer = setInterval(sweepRetention, 10 * 60 * 1000);
  timer.unref();
}

export function listProjects(query = ''): Card[] {
  const q = query.trim().toLowerCase();
  return [...projects.values()]
    .filter((project) => !q || `${project.code} ${project.name}`.toLowerCase().includes(q))
    .sort((a, b) => b.id - a.id)
    .map(toCard);
}

export function getProject(id: number) {
  const project = projects.get(id);
  if (!project) return null;
  return {
    ...toCard(project),
    mappingName: project.mappingName,
    retention: project.retention,
    mqtt: {
      broker: project.mqtt.broker,
      topic: project.mqtt.topic,
      username: project.mqtt.username,
      offlineMinutes: project.mqtt.offlineMinutes,
      hasPassword: Boolean(project.mqtt.passwordSealed),
    },
    customer: {
      endpoint: project.customer.endpoint,
      auth: project.customer.auth,
      tokenUrl: project.customer.tokenUrl,
      appId: project.customer.appId,
      retry: project.customer.retry,
      hasSecret: Boolean(project.customer.secretSealed),
    },
    test: { ...project.test, hasData: hasTestData(project) },
    areas: project.areas.map((area) => ({
      id: area.id,
      code: area.code,
      name: area.name,
      filename: area.filename,
      rows: area.rows,
      cols: area.cols,
      matrix: area.matrix,
      devices: area.devices,
      occupied: [...area.cells[0].entries()]
        .filter(([, cell]) => cell.layers > 0 || cell.unknown)
        .map(([key, cell]) => {
          const [x, y] = key.split(':').map(Number);
          return { x, y, layers: cell.layers, unknown: cell.unknown };
        }),
    })),
  };
}

export function boardJson(id: number, sandbox: 0 | 1): { version: number; json: string } | null {
  const project = projects.get(id);
  if (!project) return null;
  const key = `${id}:${sandbox}`;
  const cached = boardCache.get(key);
  if (cached) return { version: project.versions[sandbox], json: cached };
  const json = JSON.stringify(buildBoard(project, sandbox));
  boardCache.set(key, json);
  return { version: project.versions[sandbox], json };
}

export function createProject(input: ProjectInput, actor: string): { id: number } | { error: string } {
  if ([...projects.values()].some((project) => project.code.toLowerCase() === input.code.toLowerCase())) {
    return { error: '项目编码已存在，请更换' };
  }
  const now = formatTime();
  const id = tx(() => {
    const inserted = database().prepare(`
      INSERT INTO projects (code, name, note, mapping_name, retention_json, mqtt_json, customer_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(input.code, input.name, input.note, input.mappingName, JSON.stringify(input.retention), JSON.stringify(storedMqtt(input.mqtt)), JSON.stringify(storedCustomer(input.customer)), now, now);
    const projectId = Number(inserted.lastInsertRowid);
    writeAreas(projectId, input.areas, new Map());
    database().prepare(`INSERT INTO test_state (project_id) VALUES (?)`).run(projectId);
    writeLog(projectId, actor, '创建项目', input.name);
    return projectId;
  });
  remember(id);
  return { id };
}

export function updateProject(id: number, input: ProjectInput, actor: string, clearTest: boolean): { ok: true } | { error: string; code?: string } {
  const project = projects.get(id);
  if (!project) return { error: '项目不存在' };
  if (input.code.toLowerCase() !== project.code.toLowerCase()) return { error: '项目编码不可修改' };
  if (project.test.running) return { error: '测试运行中，请先关闭测试再修改项目' };
  const conflict = occupancyConflict(project, input.areas);
  if (conflict) return { error: conflict };
  if (hasTestData(project) && !clearTest) {
    return { error: '保存编辑将清除本次测试沙箱及记录，项目自身的存取数据会保留', code: 'NEED_CLEAR_TEST' };
  }
  const kept = snapshotReal(project);
  const mqtt = storedMqtt(input.mqtt, input.mqtt.password ? '' : project.mqtt.passwordSealed);
  const customer = storedCustomer(input.customer, input.customer.appSecret ? '' : project.customer.secretSealed);
  tx(() => {
    if (hasTestData(project)) clearSandbox(id);
    database().prepare(`
      UPDATE projects SET name=?, note=?, mapping_name=?, retention_json=?, mqtt_json=?, customer_json=?, updated_at=? WHERE id=?
    `).run(input.name, input.note, input.mappingName, JSON.stringify(input.retention), JSON.stringify(mqtt), JSON.stringify(customer), formatTime(), id);
    database().prepare(`DELETE FROM cells WHERE project_id=?`).run(id);
    database().prepare(`DELETE FROM devices WHERE project_id=?`).run(id);
    database().prepare(`DELETE FROM areas WHERE project_id=?`).run(id);
    writeAreas(id, input.areas, kept);
    database().prepare(`UPDATE test_state SET running=0, viewing=0, count=0, next_at=0, last_at=NULL, last_action='' WHERE project_id=?`).run(id);
    writeLog(id, actor, '编辑项目', input.name);
  });
  remember(id);
  return { ok: true };
}

export function deleteProject(id: number, code: string, actor: string): { ok: true } | { error: string } {
  const project = projects.get(id);
  if (!project) return { error: '项目不存在' };
  if (project.test.running) return { error: '测试运行中，请进入项目关闭测试后再删除' };
  if (code.trim() !== project.code) return { error: '项目编码不匹配，请重新输入' };
  tx(() => {
    for (const table of ['cells', 'devices', 'areas', 'raw_messages', 'business_events', 'seen_ids', 'test_state']) {
      database().prepare(`DELETE FROM ${table} WHERE project_id=?`).run(id);
    }
    database().prepare(`DELETE FROM projects WHERE id=?`).run(id);
    writeLog(null, actor, '删除项目', `${project.name}（${project.code}）`);
  });
  projects.delete(id);
  dropBoard(id);
  return { ok: true };
}

export function listRaw(id: number, sandbox: 0 | 1, status: string, offset: number, limit: number) {
  if (!projects.has(id)) return null;
  const rows = database().prepare(`
    SELECT id, received_at AS receivedAt, device_code AS deviceId, action, x, y, event_id AS eventId,
           status, reason, payload_json AS payload, source
    FROM raw_messages
    WHERE project_id=? AND sandbox=? AND (? = '' OR status = ?)
    ORDER BY id DESC LIMIT ? OFFSET ?
  `).all(id, sandbox, status, status, limit + 1, offset) as Record<string, unknown>[];
  return {
    items: rows.slice(0, limit).map((row) => ({ ...row, payload: JSON.parse(String(row.payload)) })),
    hasMore: rows.length > limit,
  };
}

export function listEvents(id: number, sandbox: 0 | 1, action: string, offset: number, limit: number) {
  if (!projects.has(id)) return null;
  const rows = database().prepare(`
    SELECT id, event_time AS time, area_code AS areaCode, area_name AS areaName, x, y, action,
           before_layers AS beforeLayers, after_layers AS afterLayers, device_code AS deviceId,
           source, push_status AS pushStatus, event_id AS eventId
    FROM business_events
    WHERE project_id=? AND sandbox=? AND (? = '' OR action = ?)
    ORDER BY id DESC LIMIT ? OFFSET ?
  `).all(id, sandbox, action, action, limit + 1, offset) as Record<string, unknown>[];
  return { items: rows.slice(0, limit), hasMore: rows.length > limit };
}

export function listLogs(id: number, offset: number, limit: number) {
  if (!projects.has(id)) return null;
  const rows = database().prepare(`
    SELECT id, at AS time, actor, action, object, result
    FROM op_logs WHERE project_id=? ORDER BY id DESC LIMIT ? OFFSET ?
  `).all(id, limit + 1, offset) as Record<string, unknown>[];
  return { items: rows.slice(0, limit), hasMore: rows.length > limit };
}

export function getTest(id: number): (TestMem & { hasData: boolean }) | null {
  const project = projects.get(id);
  return project ? { ...project.test, hasData: hasTestData(project) } : null;
}

export function beginTest(id: number, actor: string, intervalSec: number): { ok: true } | { error: string } {
  const project = projects.get(id);
  if (!project) return { error: '项目不存在' };
  if (project.test.running) return { error: '测试已在运行' };
  if (!project.areas.some((area) => area.devices.length && area.matrix.some((row) => row.includes(1)))) {
    return { error: '请先配置至少一个设备及有效位置' };
  }
  const createCells = !hasTestCells(project);
  tx(() => {
    if (createCells) insertEmptySandbox(project);
    database().prepare(`UPDATE test_state SET running=1, viewing=1, interval_sec=?, next_at=? WHERE project_id=?`).run(intervalSec, Date.now() + intervalSec * 1000, id);
    writeLog(id, actor, '开启测试', `${project.name} · 每 ${intervalSec} 秒 1 条`);
  });
  remember(id);
  return { ok: true };
}

export function stopTest(id: number, actor: string, reason = ''): { ok: true } | { error: string } {
  const project = projects.get(id);
  if (!project) return { error: '项目不存在' };
  if (!project.test.running) return { ok: true };
  tx(() => {
    database().prepare(`UPDATE test_state SET running=0, next_at=0 WHERE project_id=?`).run(id);
    writeLog(id, actor, '关闭测试', reason ? `${project.name} · ${reason}` : project.name);
  });
  project.test.running = false;
  project.test.nextAt = 0;
  dropBoard(id);
  return { ok: true };
}

export function setTestView(id: number, viewing: boolean): { ok: true } | { error: string } {
  const project = projects.get(id);
  if (!project) return { error: '项目不存在' };
  project.test.viewing = viewing;
  database().prepare(`UPDATE test_state SET viewing=? WHERE project_id=?`).run(viewing ? 1 : 0, id);
  dropBoard(id);
  return { ok: true };
}

export function setTestNext(id: number, nextAt: number): void {
  const project = projects.get(id);
  if (!project || !project.test.running) return;
  project.test.nextAt = nextAt;
  database().prepare(`UPDATE test_state SET next_at=? WHERE project_id=?`).run(nextAt, id);
  dropBoard(id);
}

export function planTestReport(id: number) {
  const project = projects.get(id);
  if (!project) return null;
  const choices: { area: AreaMem; x: number; y: number; layers: number }[] = [];
  for (const area of project.areas) {
    if (!area.devices.length) continue;
    for (let x = 1; x <= area.rows; x++) {
      for (let y = 1; y <= area.cols; y++) {
        if (area.matrix[x - 1][y - 1] !== 1) continue;
        const cell = area.cells[1].get(`${x}:${y}`);
        if (cell?.unknown) continue;
        choices.push({ area, x, y, layers: cell?.layers ?? 0 });
      }
    }
  }
  if (!choices.length) return null;
  const choice = choices[project.test.count % choices.length];
  const before = choice.layers;
  const action = before >= 3 ? '取梁' : before <= 0 ? '存梁' : project.test.count % 2 ? '取梁' : '存梁';
  const device = choice.area.devices[project.test.count % choice.area.devices.length];
  return {
    projectId: id,
    sandbox: 1 as const,
    source: 'TEST' as const,
    eventId: `TEST-${Date.now()}-${project.test.count + 1}`,
    deviceId: device.code,
    action: action as '存梁' | '取梁',
    x: choice.x,
    y: choice.y,
    eventTime: formatTime(),
  };
}

export function cellLayers(projectId: number, deviceId: string, x: number, y: number, sandbox: 0 | 1): number | null {
  const area = projects.get(projectId)?.devices.get(deviceId);
  if (!area) return null;
  return area.cells[sandbox].get(`${x}:${y}`)?.layers ?? null;
}

export function findUser(username: string): { id: number; name: string; passwordHash: string } | null {
  const row = database().prepare(`SELECT id, display_name AS name, password_hash AS passwordHash FROM users WHERE username=?`).get(username) as
    | { id: number; name: string; passwordHash: string }
    | undefined;
  return row ?? null;
}

export function readSampleMapping() {
  return parseMappingSheet(readFirstSheet(readFileSync(join(samplesDir, 'mapping.xlsx'))));
}

export function readSampleBoard(areaCode: string) {
  const file = areaCode === '区域1' ? 'area1.xlsx' : areaCode === '区域2' ? 'area2.xlsx' : '';
  if (!file) return { error: '没有该区域的示例棋盘' };
  return parseBoardSheet(readFirstSheet(readFileSync(join(samplesDir, file))), areaCode, `${areaCode}.xlsx`);
}

export function projectExists(id: number): boolean {
  return projects.has(id);
}

function ensureAdmin(): void {
  const row = database().prepare(`SELECT id FROM users WHERE username='admin'`).get();
  if (row) return;
  database().prepare(`INSERT INTO users (username, password_hash, display_name) VALUES ('admin', ?, '管理员')`).run(hashPassword('admin123'));
}

function loadAll(): void {
  projects.clear();
  const ids = database().prepare(`SELECT id FROM projects ORDER BY id`).all() as { id: number }[];
  for (const row of ids) remember(row.id);
}

function remember(id: number): void {
  const project = readProject(id);
  if (project) projects.set(id, project);
  else projects.delete(id);
  dropBoard(id);
}

function readProject(id: number): ProjectMem | null {
  const row = database().prepare(`SELECT * FROM projects WHERE id=?`).get(id) as Record<string, unknown> | undefined;
  if (!row) return null;
  const areas = (database().prepare(`SELECT * FROM areas WHERE project_id=? ORDER BY id`).all(id) as Record<string, unknown>[]).map(readArea);
  const devices = database().prepare(`SELECT * FROM devices WHERE project_id=? ORDER BY id`).all(id) as Record<string, unknown>[];
  for (const device of devices) {
    const area = areas.find((item) => item.id === Number(device.area_id));
    if (area) area.devices.push({ code: String(device.device_code), name: String(device.device_name) });
  }
  const cells = database().prepare(`SELECT * FROM cells WHERE project_id=?`).all(id) as Record<string, unknown>[];
  for (const cell of cells) {
    const area = areas.find((item) => item.id === Number(cell.area_id));
    if (!area) continue;
    const sandbox = Number(cell.sandbox) === 1 ? 1 : 0;
    area.cells[sandbox].set(`${cell.x}:${cell.y}`, {
      layers: Number(cell.layers),
      unknown: Number(cell.unknown) === 1,
      issue: String(cell.issue ?? ''),
      last: cell.last_event_at ? String(cell.last_event_at) : null,
      photos: parsePhotos(cell.photos_json),
    });
  }
  const seen: [Set<string>, Set<string>] = [new Set(), new Set()];
  for (const item of database().prepare(`SELECT sandbox, event_id FROM seen_ids WHERE project_id=?`).all(id) as { sandbox: number; event_id: string }[]) {
    seen[item.sandbox === 1 ? 1 : 0].add(item.event_id);
  }
  const testRow = database().prepare(`SELECT * FROM test_state WHERE project_id=?`).get(id) as Record<string, unknown> | undefined;
  const mqtt = JSON.parse(String(row.mqtt_json || '{}')) as MqttInput & { password?: string };
  const customer = JSON.parse(String(row.customer_json || '{}')) as CustomerInput & { appSecret?: string };
  const deviceMap = new Map<string, AreaMem>();
  for (const area of areas) for (const device of area.devices) deviceMap.set(device.code, area);
  return {
    id,
    code: String(row.code),
    name: String(row.name),
    note: String(row.note ?? ''),
    mappingName: String(row.mapping_name ?? ''),
    retention: { raw: null, event: null, photo: null, push: null, log: null, ...JSON.parse(String(row.retention_json || '{}')) },
    mqtt: {
      broker: mqtt.broker ?? '',
      topic: mqtt.topic ?? '',
      username: mqtt.username ?? '',
      password: '',
      passwordSealed: mqtt.password ?? '',
      offlineMinutes: mqtt.offlineMinutes ?? null,
    },
    customer: {
      endpoint: customer.endpoint ?? '',
      auth: customer.auth ?? '',
      tokenUrl: customer.tokenUrl ?? '',
      appId: customer.appId ?? '',
      appSecret: '',
      secretSealed: customer.appSecret ?? '',
      retry: customer.retry ?? null,
    },
    areas,
    devices: deviceMap,
    versions: [1, 1],
    test: {
      running: Number(testRow?.running) === 1,
      viewing: Number(testRow?.viewing) === 1,
      count: Number(testRow?.count ?? 0),
      intervalSec: Number(testRow?.interval_sec ?? 20) || 20,
      nextAt: Number(testRow?.next_at ?? 0),
      lastAt: testRow?.last_at ? String(testRow.last_at) : null,
      lastAction: String(testRow?.last_action ?? ''),
    },
    lastReal: row.last_real_at
      ? { time: String(row.last_real_at), action: String(row.last_real_action), area: String(row.last_real_area), x: Number(row.last_real_x), y: Number(row.last_real_y) }
      : null,
    seen,
  };
}

function readArea(row: Record<string, unknown>): AreaMem {
  return {
    id: Number(row.id),
    code: String(row.area_code),
    name: String(row.area_name),
    filename: String(row.filename),
    rows: Number(row.rows),
    cols: Number(row.cols),
    matrix: JSON.parse(String(row.matrix_json)) as number[][],
    devices: [],
    cells: [new Map(), new Map()],
  };
}

function parsePhotos(value: unknown): CellSnap['photos'] {
  try {
    const parsed = JSON.parse(String(value ?? '[]')) as CellSnap['photos'];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeAreas(projectId: number, areas: AreaInput[], kept: Map<string, CellSnap>): void {
  for (const area of areas) {
    const inserted = database().prepare(`
      INSERT INTO areas (project_id, area_code, area_name, filename, rows, cols, matrix_json) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(projectId, area.code, area.name, area.filename, area.rows, area.cols, JSON.stringify(area.matrix));
    const areaId = Number(inserted.lastInsertRowid);
    for (const device of area.devices) {
      database().prepare(`INSERT INTO devices (project_id, area_id, device_code, device_name) VALUES (?, ?, ?, ?)`).run(projectId, areaId, device.code, device.name);
    }
    for (let x = 1; x <= area.rows; x++) {
      for (let y = 1; y <= area.cols; y++) {
        if (area.matrix[x - 1][y - 1] !== 1) continue;
        const prev = kept.get(`${area.code}:${x}:${y}`) ?? emptyCell();
        database().prepare(`
          INSERT INTO cells (project_id, area_id, x, y, sandbox, layers, unknown, issue, last_event_at, photos_json)
          VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?)
        `).run(projectId, areaId, x, y, prev.layers, prev.unknown ? 1 : 0, prev.issue, prev.last, JSON.stringify(prev.photos));
      }
    }
  }
}

function insertEmptySandbox(project: ProjectMem): void {
  for (const area of project.areas) {
    for (let x = 1; x <= area.rows; x++) {
      for (let y = 1; y <= area.cols; y++) {
        if (area.matrix[x - 1][y - 1] !== 1) continue;
        database().prepare(`
          INSERT OR IGNORE INTO cells (project_id, area_id, x, y, sandbox, layers, unknown, issue, last_event_at, photos_json)
          VALUES (?, ?, ?, ?, 1, 0, 0, '', NULL, '[]')
        `).run(project.id, area.id, x, y);
      }
    }
  }
}

function snapshotReal(project: ProjectMem): Map<string, CellSnap> {
  const kept = new Map<string, CellSnap>();
  for (const area of project.areas) {
    for (const [key, cell] of area.cells[0]) kept.set(`${area.code}:${key}`, cloneCell(cell));
  }
  return kept;
}

function occupancyConflict(project: ProjectMem, areas: AreaInput[]): string | null {
  for (const area of project.areas) {
    const next = areas.find((item) => item.code === area.code);
    for (const [key, cell] of area.cells[0]) {
      if (cell.layers <= 0 && !cell.unknown) continue;
      const [x, y] = key.split(':').map(Number);
      if (next?.matrix[x - 1]?.[y - 1] !== 1) return `区域 ${area.code} 的 X${x} Y${y} 已有占用或待核实，不能直接覆盖`;
    }
  }
  return null;
}

function hasTestCells(project: ProjectMem): boolean {
  return project.areas.some((area) => area.cells[1].size > 0);
}

export function hasTestData(project: ProjectMem): boolean {
  return project.test.count > 0 || project.test.viewing || project.test.running || hasTestCells(project);
}

function clearSandbox(id: number): void {
  database().prepare(`DELETE FROM cells WHERE project_id=? AND sandbox=1`).run(id);
  database().prepare(`DELETE FROM raw_messages WHERE project_id=? AND sandbox=1`).run(id);
  database().prepare(`DELETE FROM business_events WHERE project_id=? AND sandbox=1`).run(id);
  database().prepare(`DELETE FROM seen_ids WHERE project_id=? AND sandbox=1`).run(id);
}

function storedMqtt(input: MqttInput, keep = ''): MqttInput & { password: string } {
  return {
    broker: input.broker,
    topic: input.topic,
    username: input.username,
    offlineMinutes: input.offlineMinutes,
    password: input.password ? seal(input.password) : keep,
  };
}

function storedCustomer(input: CustomerInput, keep = ''): CustomerInput {
  return { ...input, appSecret: input.appSecret ? seal(input.appSecret) : keep };
}

function writeLog(projectId: number | null, actor: string, action: string, object: string): void {
  database().prepare(`INSERT INTO op_logs (project_id, at, actor, action, object, result) VALUES (?, ?, ?, ?, ?, '完成')`).run(projectId, formatTime(), actor, action, object);
}

function toCard(project: ProjectMem): Card {
  let valid = 0;
  let devices = 0;
  for (const area of project.areas) {
    valid += countMatrix(area.matrix).valid;
    devices += area.devices.length;
  }
  return {
    id: project.id,
    code: project.code,
    name: project.name,
    note: project.note,
    areaCount: project.areas.length,
    deviceCount: devices,
    validCount: valid,
    testRunning: project.test.running,
    lastReal: project.lastReal,
    lastTest: project.test.lastAt ? { time: project.test.lastAt, action: project.test.lastAction } : null,
  };
}

function buildBoard(project: ProjectMem, sandbox: 0 | 1) {
  return {
    id: project.id,
    code: project.code,
    name: project.name,
    sandbox,
    version: project.versions[sandbox],
    accessStatus: 'not_connected' as const,
    test: project.test,
    lastReal: project.lastReal,
    areas: project.areas.map((area) => {
      const cells = [];
      let free = 0;
      let used = 0;
      let unknown = 0;
      let layers = 0;
      let total = 0;
      for (let x = 1; x <= area.rows; x++) {
        for (let y = 1; y <= area.cols; y++) {
          const invalid = area.matrix[x - 1][y - 1] !== 1;
          const state = area.cells[sandbox].get(`${x}:${y}`) ?? emptyCell();
          if (!invalid) {
            total += 1;
            layers += state.layers;
            if (state.unknown) unknown += 1;
            else if (state.layers > 0) used += 1;
            else free += 1;
          }
          cells.push({
            x,
            y,
            invalid,
            unknown: state.unknown,
            layers: invalid ? 0 : state.layers,
            issue: invalid ? '' : state.issue,
            last: invalid ? null : state.last,
            photos: invalid ? [] : state.photos,
          });
        }
      }
      return {
        id: area.id,
        code: area.code,
        name: area.name,
        filename: area.filename,
        rows: area.rows,
        cols: area.cols,
        devices: area.devices,
        stats: { total, free, used, unknown, layers },
        cells,
      };
    }),
  };
}

function recoverTests(): void {
  for (const project of projects.values()) {
    if (!project.test.running) continue;
    database().prepare(`UPDATE test_state SET running=0, next_at=0 WHERE project_id=?`).run(project.id);
    writeLog(project.id, '系统', '关闭测试', `${project.name} · 服务重启，未自动恢复`);
    project.test.running = false;
    project.test.nextAt = 0;
  }
}

function sweepRetention(): void {
  for (const project of projects.values()) {
    purge('raw_messages', 'received_at', project.id, project.retention.raw);
    purge('business_events', 'event_time', project.id, shorter(project.retention.event, project.retention.push));
    purge('op_logs', 'at', project.id, project.retention.log);
  }
}

function shorter(a: number | null, b: number | null): number | null {
  if (a == null) return b;
  if (b == null) return a;
  return Math.min(a, b);
}

function purge(table: string, column: string, projectId: number, days: number | null): void {
  if (!days) return;
  const cutoff = formatTime(new Date(Date.now() - days * 86400000));
  database().prepare(`DELETE FROM ${table} WHERE id IN (SELECT id FROM ${table} WHERE project_id=? AND ${column} < ? LIMIT 400)`).run(projectId, cutoff);
}

function seedSamples(): void {
  const mapping = readSampleMapping();
  if ('error' in mapping) throw new Error(mapping.error);
  const areas: AreaInput[] = [];
  for (const area of mapping.areas) {
    const board = readSampleBoard(area.code);
    if ('error' in board) throw new Error(board.error);
    areas.push({ code: area.code, name: area.name, filename: `${area.code}.xlsx`, devices: area.devices, ...board });
  }
  const blank = { raw: null, event: null, photo: null, push: null, log: null } satisfies Retention;
  const mqtt = { broker: '', topic: '', username: '', password: '', offlineMinutes: null } satisfies MqttInput;
  const customer = { endpoint: '', auth: '' as const, tokenUrl: '', appId: '', appSecret: '', retry: null };
  const created = createProject({
    code: 'LC001',
    name: '示例梁场项目',
    note: '按附件示例导入。初始占用为空，MQTT 未接入。',
    mappingName: '区域-龙门吊映射表.xlsx',
    retention: blank,
    mqtt,
    customer,
    areas,
  }, '系统');
  if ('error' in created) throw new Error(created.error);
  const second = createProject({
    code: 'LC002',
    name: '第二项目示例',
    note: '用于确认项目之间的数据隔离。',
    mappingName: '手工示例',
    retention: blank,
    mqtt,
    customer,
    areas: [{
      code: '西区',
      name: '西侧存梁区',
      filename: '西区.xlsx',
      devices: [{ code: 'LM004', name: '龙门吊 04' }],
      rows: 3,
      cols: 4,
      matrix: [
        [1, 1, 1, 1],
        [1, 1, 1, 1],
        [1, 1, 0, 0],
      ],
    }],
  }, '系统');
  if ('error' in second) throw new Error(second.error);
}
