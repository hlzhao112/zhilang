import type { ServerResponse } from 'node:http';

type Subscriber = ServerResponse;

const rooms = new Map<number, Set<Subscriber>>();

export function subscribe(projectId: number, res: Subscriber): void {
  let room = rooms.get(projectId);
  if (!room) {
    room = new Set();
    rooms.set(projectId, room);
  }
  room.add(res);
  res.on('close', () => unsubscribe(projectId, res));
}

export function unsubscribe(projectId: number, res: Subscriber): void {
  const room = rooms.get(projectId);
  if (!room) return;
  room.delete(res);
  if (!room.size) rooms.delete(projectId);
}

export function publish(projectId: number, payload: unknown): void {
  const room = rooms.get(projectId);
  if (!room) return;
  const chunk = `event: update\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of room) {
    if (res.destroyed) {
      room.delete(res);
      continue;
    }
    res.write(chunk);
  }
}

export function subscriberCount(): number {
  let n = 0;
  for (const room of rooms.values()) n += room.size;
  return n;
}

setInterval(() => {
  for (const room of rooms.values()) {
    for (const res of room) {
      if (!res.destroyed) res.write(': ping\n\n');
    }
  }
}, 25000).unref();
