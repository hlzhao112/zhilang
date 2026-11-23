export type Action = '存梁' | '取梁';
export type Source = 'TEST' | 'MANUAL' | 'DEVICE';
export type Status = '已处理' | '待核实' | '异常' | '重复';

export type Photo = { layer: number; time: string; eventId: string };

export type CellSnap = {
  layers: number;
  unknown: boolean;
  issue: string;
  last: string | null;
  photos: Photo[];
};

export type Report = {
  projectId: number;
  sandbox: 0 | 1;
  source: Source;
  eventId: string;
  deviceId: string;
  action: Action;
  x: number;
  y: number;
  eventTime: string;
};

export type Decision = {
  status: Status;
  reason: string;
  before: number | null;
  after: number | null;
  next: CellSnap | null;
  recordSeen: boolean;
  push: boolean;
};

export type Retention = {
  raw: number | null;
  event: number | null;
  photo: number | null;
  push: number | null;
  log: number | null;
};

export type MqttInput = {
  broker: string;
  topic: string;
  username: string;
  password: string;
  offlineMinutes: number | null;
};

export type CustomerInput = {
  endpoint: string;
  auth: '' | '无鉴权' | 'Token';
  tokenUrl: string;
  appId: string;
  appSecret: string;
  retry: number | null;
};

export type AreaInput = {
  code: string;
  name: string;
  filename: string;
  devices: { code: string; name: string }[];
  rows: number;
  cols: number;
  matrix: number[][];
};

export type ProjectInput = {
  code: string;
  name: string;
  note: string;
  mappingName: string;
  retention: Retention;
  mqtt: MqttInput;
  customer: CustomerInput;
  areas: AreaInput[];
};

export function emptyCell(): CellSnap {
  return { layers: 0, unknown: false, issue: '', last: null, photos: [] };
}

export function cloneCell(cell: CellSnap): CellSnap {
  return {
    layers: cell.layers,
    unknown: cell.unknown,
    issue: cell.issue,
    last: cell.last,
    photos: cell.photos.map((photo) => ({ ...photo })),
  };
}

export function formatTime(date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${pick('year')}-${pick('month')}-${pick('day')} ${pick('hour')}:${pick('minute')}:${pick('second')}`;
}

export function normalizeAction(value: unknown): Action | null {
  const text = String(value ?? '').trim();
  const upper = text.toUpperCase();
  if (text === '存梁' || upper === 'STORE') return '存梁';
  if (text === '取梁' || upper === 'TAKE') return '取梁';
  return null;
}

export function decide(args: {
  eventId: string;
  duplicate: boolean;
  action: Action;
  knownDevice: boolean;
  cell: { invalid: boolean; state: CellSnap } | null;
  time: string;
}): Decision {
  const id = args.eventId.trim();
  if (!id) {
    return pending('缺少唯一事件 ID，无法安全去重', touchIssue(args, '待核实'));
  }
  if (args.duplicate) {
    return { status: '重复', reason: '事件 ID 已处理，不重复更新', before: null, after: null, next: null, recordSeen: false, push: false };
  }
  if (!args.knownDevice) {
    return anomaly('设备未绑定到当前项目', null, true);
  }
  if (!args.cell || args.cell.invalid) {
    return anomaly('坐标无效或不可存放', null, true);
  }
  if (args.cell.state.unknown) {
    return pending('初始状态未核实', touchIssue(args, '待核实'));
  }
  const state = cloneCell(args.cell.state);
  if (args.action === '存梁' && state.layers >= 3) {
    state.issue = '异常';
    return anomaly('该位置已满 3 层', state, true);
  }
  if (args.action === '取梁' && state.layers <= 0) {
    state.issue = '异常';
    return anomaly('该位置为空，无法取梁', state, true);
  }
  const before = state.layers;
  if (args.action === '存梁') {
    state.layers += 1;
    state.photos.push({ layer: state.layers, time: args.time, eventId: id });
  } else {
    state.layers -= 1;
    state.photos = state.photos.filter((photo) => photo.layer <= state.layers);
  }
  state.issue = '';
  state.last = args.time;
  return {
    status: '已处理',
    reason: args.action === '存梁' ? '已记录存梁，层数加一；未收到真实照片' : '已记录取梁，移除最高层；下层记录保留',
    before,
    after: state.layers,
    next: state,
    recordSeen: true,
    push: true,
  };
}

function touchIssue(args: { cell: { invalid: boolean; state: CellSnap } | null }, issue: string): CellSnap | null {
  if (!args.cell || args.cell.invalid) return null;
  const next = cloneCell(args.cell.state);
  next.issue = issue;
  return next;
}

function pending(reason: string, next: CellSnap | null): Decision {
  return { status: '待核实', reason, before: null, after: null, next, recordSeen: false, push: false };
}

function anomaly(reason: string, next: CellSnap | null, recordSeen: boolean): Decision {
  return { status: '异常', reason, before: null, after: null, next, recordSeen, push: false };
}

export function pushStatus(source: Source, endpoint: string): string {
  if (source === 'TEST') return '测试·未发送';
  return endpoint.trim() ? '未启用' : '未配置';
}

const RETENTION_KEYS = ['raw', 'event', 'photo', 'push', 'log'] as const;

export function parseProjectInput(body: unknown, mode: 'create' | 'edit'): { value: ProjectInput } | { error: string } {
  if (!body || typeof body !== 'object') return { error: '请求格式不正确' };
  const raw = body as Record<string, unknown>;
  const code = String(raw.code ?? '').trim();
  const name = String(raw.name ?? '').trim();
  const note = String(raw.note ?? '').trim();
  if (!code || !name) return { error: '请填写项目编码和项目名称' };
  if (!/^[A-Za-z0-9]+$/.test(code)) return { error: '项目编码仅支持英文和数字' };
  if (code.length > 32 || name.length > 40) return { error: '项目编码或名称过长' };
  if (note.length > 200) return { error: '备注请控制在 200 字以内' };

  const retentionResult = parseRetention(raw.retention);
  if ('error' in retentionResult) return retentionResult;
  const mqttResult = parseMqtt(raw.mqtt);
  if ('error' in mqttResult) return mqttResult;
  const customerResult = parseCustomer(raw.customer);
  if ('error' in customerResult) return customerResult;
  const areasResult = parseAreas(raw.areas);
  if ('error' in areasResult) return areasResult;
  if (mode === 'create' && !areasResult.areas.length) return { error: '请先上传映射表并完成所有区域的棋盘配置' };

  return {
    value: {
      code,
      name,
      note,
      mappingName: String(raw.mappingName ?? '').trim() || '未命名映射',
      retention: retentionResult.retention,
      mqtt: mqttResult.mqtt,
      customer: customerResult.customer,
      areas: areasResult.areas,
    },
  };
}

function parseRetention(value: unknown): { retention: Retention } | { error: string } {
  const source = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const retention = {} as Retention;
  for (const key of RETENTION_KEYS) {
    const parsed = optionalInt(source[key], 1);
    if (parsed.error) return { error: '保存时长请填写正整数，留空表示待确认' };
    retention[key] = parsed.value;
  }
  return { retention };
}

function parseMqtt(value: unknown): { mqtt: MqttInput } | { error: string } {
  const source = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const offline = optionalInt(source.offlineMinutes, 1);
  if (offline.error) return { error: '设备离线判定阈值请填写正整数' };
  return {
    mqtt: {
      broker: clip(source.broker, 200),
      topic: clip(source.topic, 200),
      username: clip(source.username, 80),
      password: clip(source.password, 200),
      offlineMinutes: offline.value,
    },
  };
}

function parseCustomer(value: unknown): { customer: CustomerInput } | { error: string } {
  const source = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const endpoint = clip(source.endpoint, 300);
  const tokenUrl = clip(source.tokenUrl, 300);
  if (endpoint && !/^https?:\/\//i.test(endpoint)) return { error: '客户接口地址请填写完整的 HTTP(S) 地址' };
  if (tokenUrl && !/^https?:\/\//i.test(tokenUrl)) return { error: 'Token 地址请填写完整的 HTTP(S) 地址' };
  const authRaw = clip(source.auth, 20);
  if (authRaw && authRaw !== '无鉴权' && authRaw !== 'Token') return { error: '鉴权方式无法识别' };
  const retry = optionalInt(source.retry, 0);
  if (retry.error) return { error: '失败重试次数请填写 0 或正整数' };
  return {
    customer: {
      endpoint,
      auth: (authRaw || '') as CustomerInput['auth'],
      tokenUrl,
      appId: clip(source.appId, 80),
      appSecret: clip(source.appSecret, 200),
      retry: retry.value,
    },
  };
}

function parseAreas(value: unknown): { areas: AreaInput[] } | { error: string } {
  if (!Array.isArray(value) || !value.length) return { error: '请先上传映射表并完成所有区域的棋盘配置' };
  const areas: AreaInput[] = [];
  const areaCodes = new Set<string>();
  const deviceCodes = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== 'object') return { error: '区域数据不正确' };
    const row = item as Record<string, unknown>;
    const code = String(row.code ?? '').trim();
    const name = String(row.name ?? '').trim();
    if (!code || !name) return { error: '区域 ID 和区域名称不能为空' };
    if (areaCodes.has(code)) return { error: `区域 ${code} 重复` };
    areaCodes.add(code);
    if (!Array.isArray(row.devices) || !row.devices.length) return { error: `区域 ${code} 没有龙门吊` };
    const devices: { code: string; name: string }[] = [];
    for (const device of row.devices) {
      const d = device as Record<string, unknown>;
      const deviceCode = String(d.code ?? '').trim();
      const deviceName = String(d.name ?? '').trim();
      if (!deviceCode || !deviceName) return { error: `区域 ${code} 存在空的龙门吊信息` };
      if (deviceCodes.has(deviceCode)) return { error: `龙门吊 ID ${deviceCode} 重复` };
      deviceCodes.add(deviceCode);
      devices.push({ code: deviceCode, name: deviceName });
    }
    const matrix = row.matrix;
    if (!Array.isArray(matrix) || !matrix.length || !Array.isArray(matrix[0])) return { error: `区域 ${code} 还没有棋盘` };
    const rows = matrix.length;
    const cols = (matrix[0] as unknown[]).length;
    if (rows > 100 || cols > 100) return { error: '棋盘超过 100 × 100，当前不接受' };
    const grid: number[][] = [];
    let valid = 0;
    for (let x = 0; x < rows; x++) {
      const line = matrix[x];
      if (!Array.isArray(line) || line.length !== cols) return { error: `区域 ${code} 的棋盘不是完整矩形` };
      const next: number[] = [];
      for (let y = 0; y < cols; y++) {
        const cell = line[y];
        if (cell !== 0 && cell !== 1) return { error: `区域 ${code} 第 ${x + 1} 行第 ${y + 1} 列必须是 0 或 1` };
        next.push(cell);
        if (cell === 1) valid += 1;
      }
      grid.push(next);
    }
    if (!valid) return { error: `区域 ${code} 至少需要一个可存放位置` };
    areas.push({
      code,
      name,
      filename: String(row.filename ?? `${code}.xlsx`).trim() || `${code}.xlsx`,
      devices,
      rows,
      cols,
      matrix: grid,
    });
  }
  return { areas };
}

function optionalInt(value: unknown, min: number): { value: number | null; error?: string } {
  if (value === null || value === undefined || value === '') return { value: null };
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) return { value: null, error: 'invalid' };
  const num = Number(text);
  if (num < min) return { value: null, error: 'invalid' };
  return { value: num };
}

function clip(value: unknown, max: number): string {
  return String(value ?? '').trim().slice(0, max);
}

export type SheetCell = { row: number; col: number; value: string; numeric: boolean; formula: boolean };

export function parseMappingSheet(cells: SheetCell[]): { areas: { code: string; name: string; devices: { code: string; name: string }[] }[] } | { error: string } {
  const headers = ['区域ID', '区域名称', '龙门吊ID', '龙门吊名称'];
  const cols = headers.map((name) => {
    const found = cells.find((cell) => cell.row === 1 && cell.value.trim() === name);
    return found?.col ?? 0;
  });
  if (cols.some((col) => !col)) return { error: `映射表缺少表头：${headers.filter((_, i) => !cols[i]).join('、')}` };
  const max = cells.reduce((n, cell) => Math.max(n, cell.row), 1);
  const groups: { code: string; name: string; devices: { code: string; name: string }[] }[] = [];
  const ids = new Set<string>();
  for (let row = 2; row <= max; row++) {
    const vals = cols.map((col) => String(cells.find((cell) => cell.row === row && cell.col === col)?.value ?? '').trim());
    if (vals.every((item) => !item)) continue;
    if (vals.some((item) => !item)) return { error: `映射表第 ${row} 行存在空值` };
    const [code, name, deviceId, deviceName] = vals;
    if (ids.has(deviceId)) return { error: `映射表第 ${row} 行龙门吊 ID 重复` };
    ids.add(deviceId);
    let area = groups.find((item) => item.code === code);
    if (area && area.name !== name) return { error: `区域 ${code} 的名称不一致` };
    if (!area) {
      area = { code, name, devices: [] };
      groups.push(area);
    }
    area.devices.push({ code: deviceId, name: deviceName });
  }
  if (!groups.length) return { error: '映射表没有设备记录' };
  return { areas: groups };
}

export function parseBoardSheet(cells: SheetCell[], areaCode: string, filename: string): { rows: number; cols: number; matrix: number[][] } | { error: string } {
  const stem = filename.replace(/\.xlsx$/i, '');
  if (stem !== areaCode) return { error: `文件名应为 ${areaCode}.xlsx` };
  if (!cells.length) return { error: '棋盘为空' };
  if (cells.some((cell) => cell.formula)) return { error: '棋盘不能包含公式' };
  const rows = Math.max(...cells.map((cell) => cell.row));
  const cols = Math.max(...cells.map((cell) => cell.col));
  if (rows > 100 || cols > 100) return { error: '棋盘超过 100 × 100，当前不接受' };
  const matrix: number[][] = [];
  let valid = 0;
  for (let x = 1; x <= rows; x++) {
    const line: number[] = [];
    for (let y = 1; y <= cols; y++) {
      const cell = cells.find((item) => item.row === x && item.col === y);
      if (!cell || !cell.numeric || (cell.value !== '0' && cell.value !== '1')) {
        return { error: `第 ${x} 行第 ${y} 列必须是数字 0 或 1` };
      }
      const bit = cell.value === '1' ? 1 : 0;
      line.push(bit);
      if (bit === 1) valid += 1;
    }
    matrix.push(line);
  }
  if (!valid) return { error: '至少需要一个可存放位置' };
  return { rows, cols, matrix };
}

export function countMatrix(matrix: number[][]) {
  let valid = 0;
  let blocked = 0;
  for (const row of matrix) {
    for (const bit of row) {
      if (bit === 1) valid += 1;
      else blocked += 1;
    }
  }
  return { valid, blocked };
}
