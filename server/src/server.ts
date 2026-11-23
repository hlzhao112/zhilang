import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import { formatTime, normalizeAction, parseBoardSheet, parseMappingSheet, parseProjectInput } from './domain.js';
import { readSession, signSession, verifyPassword } from './crypto.js';
import { subscribe } from './hub.js';
import { enqueue, ingestStats } from './pipeline.js';
import {
  boardJson,
  createProject,
  deleteProject,
  findUser,
  getProject,
  getTest,
  listEvents,
  listLogs,
  listProjects,
  listRaw,
  projectExists,
  readSampleBoard,
  readSampleMapping,
  setTestView,
  updateProject,
} from './repo.js';
import { webDist } from './paths.js';
import { disarm, parseInterval, startTest, stopRunningTest } from './simulator.js';
import { publish } from './hub.js';
import { readFirstSheet } from './xlsx.js';

declare module 'fastify' {
  interface FastifyRequest {
    user: { id: number; name: string } | null;
  }
}

const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

export function buildServer() {
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });
  app.decorateRequest('user', null);
  app.register(cookie);
  app.register(multipart, { limits: { fileSize: 5 * 1024 * 1024, files: 1 } });

  app.addHook('preHandler', async (req, reply) => {
    if (!req.url.startsWith('/api')) return;
    const path = req.url.split('?')[0];
    if (path === '/api/health' || path === '/api/auth/login') return;
    const user = readSession(req.cookies.sid);
    if (!user) return reply.code(401).send({ error: '请先登录' });
    req.user = { id: user.userId, name: user.name };
  });

  app.get('/api/health', async () => ({ ok: true, mqtt: 'disabled', ingest: ingestStats() }));

  app.post('/api/auth/login', async (req, reply) => {
    const body = req.body as { username?: string; password?: string };
    const user = findUser(String(body?.username ?? '').trim());
    if (!user || !verifyPassword(String(body?.password ?? ''), user.passwordHash)) {
      return reply.code(401).send({ error: '账号或密码不正确' });
    }
    reply.setCookie('sid', signSession(user.id, user.name), { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 7 * 24 * 3600 });
    return { name: user.name };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    reply.clearCookie('sid', { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/me', async (req) => ({ name: req.user?.name ?? '' }));
  app.get('/api/ingest', async () => ingestStats());
  app.get('/api/projects', async (req) => listProjects(String((req.query as { q?: string }).q ?? '')));

  app.get('/api/projects/:id', async (req, reply) => {
    const project = getProject(Number((req.params as { id: string }).id));
    if (!project) return reply.code(404).send({ error: '项目不存在' });
    return project;
  });

  app.post('/api/projects', async (req, reply) => {
    const parsed = parseProjectInput(req.body, 'create');
    if ('error' in parsed) return reply.code(400).send(parsed);
    const created = createProject(parsed.value, req.user?.name ?? '管理员');
    if ('error' in created) return reply.code(400).send(created);
    return created;
  });

  app.put('/api/projects/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const parsed = parseProjectInput(req.body, 'edit');
    if ('error' in parsed) return reply.code(400).send(parsed);
    const clearTest = Boolean((req.body as { clearTest?: boolean }).clearTest);
    const updated = updateProject(id, parsed.value, req.user?.name ?? '管理员', clearTest);
    if ('error' in updated) return reply.code(updated.code === 'NEED_CLEAR_TEST' ? 409 : 400).send(updated);
    publish(id, { type: 'reload' });
    return { ok: true };
  });

  app.delete('/api/projects/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    disarm(id);
    const removed = deleteProject(id, String((req.body as { code?: string })?.code ?? ''), req.user?.name ?? '管理员');
    if ('error' in removed) return reply.code(400).send(removed);
    return { ok: true };
  });

  app.get('/api/projects/:id/board', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const sandbox = (req.query as { sandbox?: string }).sandbox === '1' ? 1 : 0;
    const board = boardJson(id, sandbox);
    if (!board) return reply.code(404).send({ error: '项目不存在' });
    const test = getTest(id);
    const stamp = test ? `${Number(test.running)}.${Number(test.viewing)}.${test.count}.${test.nextAt}.${test.intervalSec}` : '0';
    const etag = `"${sandbox}-${board.version}-${stamp}"`;
    reply.header('etag', etag);
    reply.header('cache-control', 'no-cache');
    if (req.headers['if-none-match'] === etag) return reply.code(304).send();
    return reply.type('application/json; charset=utf-8').send(board.json);
  });

  app.get('/api/projects/:id/events', async (req, reply) => page(req, reply, listEvents));
  app.get('/api/projects/:id/raw', async (req, reply) => page(req, reply, listRaw));
  app.get('/api/projects/:id/logs', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const query = req.query as { offset?: string; limit?: string };
    const result = listLogs(id, numberParam(query.offset), Math.min(100, numberParam(query.limit) || 30));
    if (!result) return reply.code(404).send({ error: '项目不存在' });
    return result;
  });

  app.post('/api/projects/:id/test/start', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const intervalSec = parseInterval((req.body as { intervalSec?: unknown } | null)?.intervalSec);
    if (intervalSec == null) return reply.code(400).send({ error: '生成间隔请填写 1 到 600 的整数秒' });
    const started = await startTest(id, req.user?.name ?? '管理员', intervalSec);
    if ('error' in started) return reply.code(400).send(started);
    return started;
  });

  app.post('/api/projects/:id/test/stop', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const stopped = stopRunningTest(id, req.user?.name ?? '管理员');
    if ('error' in stopped) return reply.code(400).send(stopped);
    return { test: getTest(id) };
  });

  app.post('/api/projects/:id/test/view', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const viewing = Boolean((req.body as { viewing?: boolean }).viewing);
    const result = setTestView(id, viewing);
    if ('error' in result) return reply.code(404).send(result);
    return { test: getTest(id) };
  });

  app.post('/api/projects/:id/simulate', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!projectExists(id)) return reply.code(404).send({ error: '项目不存在' });
    const body = req.body as { deviceId?: string; action?: string; x?: number; y?: number; eventId?: string };
    const action = normalizeAction(body.action);
    const x = Number(body.x);
    const y = Number(body.y);
    if (!action) return reply.code(400).send({ error: '请选择存梁或取梁' });
    if (!String(body.deviceId ?? '').trim()) return reply.code(400).send({ error: '请选择龙门吊' });
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 1 || y < 1) return reply.code(400).send({ error: 'X、Y 请输入从 1 开始的整数' });
    return enqueue({
      projectId: id,
      sandbox: 0,
      source: 'MANUAL',
      eventId: String(body.eventId ?? '').trim(),
      deviceId: String(body.deviceId).trim(),
      action,
      x,
      y,
      eventTime: formatTime(),
    });
  });

  app.get('/api/projects/:id/stream', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!projectExists(id)) return reply.code(404).send({ error: '项目不存在' });
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    subscribe(id, res);
  });

  app.get('/api/samples/mapping', async () => {
    const parsed = readSampleMapping();
    if ('error' in parsed) return parsed;
    return { filename: '区域-龙门吊映射表.xlsx', ...parsed };
  });

  app.get('/api/samples/board/:code', async (req, reply) => {
    const code = decodeURIComponent((req.params as { code: string }).code);
    const parsed = readSampleBoard(code);
    if ('error' in parsed) return reply.code(404).send(parsed);
    return { filename: `${code}.xlsx`, ...parsed };
  });

  app.post('/api/parse/mapping', async (req, reply) => {
    const file = await readUpload(req);
    if ('error' in file) return reply.code(400).send(file);
    try {
      const parsed = parseMappingSheet(readFirstSheet(file.buffer));
      if ('error' in parsed) return reply.code(400).send(parsed);
      return { filename: file.name, ...parsed };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : '映射表读取失败' });
    }
  });

  app.post('/api/parse/board', async (req, reply) => {
    const areaCode = String((req.query as { areaCode?: string }).areaCode ?? '');
    const file = await readUpload(req);
    if ('error' in file) return reply.code(400).send(file);
    try {
      const parsed = parseBoardSheet(readFirstSheet(file.buffer), areaCode, file.name);
      if ('error' in parsed) return reply.code(400).send(parsed);
      return { filename: file.name, ...parsed };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : '棋盘读取失败' });
    }
  });

  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api')) return reply.code(404).send({ error: '未找到' });
    return sendWeb(req, reply);
  });

  app.setErrorHandler((error, _req, reply) => {
    const status = (error as { statusCode?: number }).statusCode;
    if (status === 413) return reply.code(413).send({ error: '文件超过 5 MB' });
    console.error(error);
    return reply.code(500).send({ error: '服务器处理失败' });
  });

  return app;
}

function page(req: FastifyRequest, reply: FastifyReply, load: (id: number, sandbox: 0 | 1, filter: string, offset: number, limit: number) => unknown) {
  const id = Number((req.params as { id: string }).id);
  const query = req.query as { sandbox?: string; status?: string; action?: string; offset?: string; limit?: string };
  const sandbox = query.sandbox === '1' ? 1 : 0;
  const filter = String(query.status ?? query.action ?? '');
  const result = load(id, sandbox, filter, numberParam(query.offset), Math.min(100, numberParam(query.limit) || 30));
  if (!result) return reply.code(404).send({ error: '项目不存在' });
  return result;
}

function numberParam(value: string | undefined): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

async function readUpload(req: FastifyRequest): Promise<{ name: string; buffer: Buffer } | { error: string }> {
  const file = await req.file();
  if (!file) return { error: '请选择 .xlsx 文件' };
  if (!file.filename.toLowerCase().endsWith('.xlsx')) return { error: '请选择 .xlsx 文件' };
  const buffer = await file.toBuffer();
  return { name: file.filename, buffer };
}

function sendWeb(req: FastifyRequest, reply: FastifyReply) {
  if (!existsSync(webDist)) return reply.code(404).type('text/plain; charset=utf-8').send('页面尚未构建。开发时请打开 http://localhost:5173');
  const root = resolve(webDist);
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  let file = resolve(root, `.${urlPath}`);
  if (!file.startsWith(root)) return reply.code(400).send('路径不正确');
  if (!existsSync(file) || !statSync(file).isFile()) file = join(root, 'index.html');
  const ext = extname(file);
  return reply.type(types[ext] || 'application/octet-stream').send(readFileSync(file));
}
