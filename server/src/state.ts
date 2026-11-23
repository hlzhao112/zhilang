import type { CellSnap, CustomerInput, MqttInput, Retention } from './domain.js';

export type AreaMem = {
  id: number;
  code: string;
  name: string;
  filename: string;
  rows: number;
  cols: number;
  matrix: number[][];
  devices: { code: string; name: string }[];
  cells: [Map<string, CellSnap>, Map<string, CellSnap>];
};

export type TestMem = {
  running: boolean;
  viewing: boolean;
  count: number;
  intervalSec: number;
  nextAt: number;
  lastAt: string | null;
  lastAction: string;
};

export type LastReal = { time: string; action: string; area: string; x: number; y: number } | null;

export type ProjectMem = {
  id: number;
  code: string;
  name: string;
  note: string;
  mappingName: string;
  retention: Retention;
  mqtt: MqttInput & { passwordSealed: string };
  customer: CustomerInput & { secretSealed: string };
  areas: AreaMem[];
  devices: Map<string, AreaMem>;
  versions: [number, number];
  test: TestMem;
  lastReal: LastReal;
  seen: [Set<string>, Set<string>];
};

export const projects = new Map<number, ProjectMem>();
export const boardCache = new Map<string, string>();

export function dropBoard(id: number): void {
  boardCache.delete(`${id}:0`);
  boardCache.delete(`${id}:1`);
}
