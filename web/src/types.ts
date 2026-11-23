export type LastReal = { time: string; action: string; area: string; x: number; y: number } | null;

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

export type TestState = {
  running: boolean;
  viewing: boolean;
  count: number;
  intervalSec: number;
  nextAt: number;
  lastAt: string | null;
  lastAction: string;
  hasData?: boolean;
};

export type Device = { code: string; name: string };

export type AreaDetail = {
  id: number;
  code: string;
  name: string;
  filename: string;
  rows: number;
  cols: number;
  matrix: number[][];
  devices: Device[];
  occupied: { x: number; y: number; layers: number; unknown: boolean }[];
};

export type ProjectDetail = Card & {
  mappingName: string;
  retention: Record<'raw' | 'event' | 'photo' | 'push' | 'log', number | null>;
  mqtt: { broker: string; topic: string; username: string; offlineMinutes: number | null; hasPassword: boolean };
  customer: { endpoint: string; auth: string; tokenUrl: string; appId: string; retry: number | null; hasSecret: boolean };
  test: TestState;
  areas: AreaDetail[];
};

export type Photo = { layer: number; time: string; eventId: string };

export type YardCell = {
  x: number;
  y: number;
  invalid: boolean;
  unknown: boolean;
  layers: number;
  issue: string;
  last: string | null;
  photos: Photo[];
};

export type YardArea = {
  id: number;
  code: string;
  name: string;
  filename: string;
  rows: number;
  cols: number;
  devices: Device[];
  stats: { total: number; free: number; used: number; unknown: number; layers: number };
  cells: YardCell[];
};

export type Board = {
  id: number;
  code: string;
  name: string;
  sandbox: 0 | 1;
  version: number;
  accessStatus: 'not_connected';
  test: TestState;
  lastReal: LastReal;
  areas: YardArea[];
};

export type PushRow = {
  id: number;
  time: string;
  areaCode: string;
  areaName: string;
  x: number;
  y: number;
  action: string;
  beforeLayers: number;
  afterLayers: number;
  deviceId: string;
  source: string;
  pushStatus: string;
  eventId: string;
};

export type RawRow = {
  id: number;
  receivedAt: string;
  deviceId: string;
  action: string;
  x: number;
  y: number;
  eventId: string;
  status: string;
  reason: string;
  payload: Record<string, unknown>;
  source: string;
};

export type LogRow = {
  id: number;
  time: string;
  actor: string;
  action: string;
  object: string;
  result: string;
};

export type Page<T> = { items: T[]; hasMore: boolean };

export type DeltaCell = {
  areaId: number;
  x: number;
  y: number;
  layers: number;
  unknown: boolean;
  issue: string;
  last: string | null;
  photos: Photo[];
};

export type StreamMessage =
  | { type: 'delta'; sandbox: 0 | 1; version: number; cells: DeltaCell[]; test: TestState; lastReal: LastReal }
  | { type: 'reload'; test?: TestState };
