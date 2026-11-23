import { useCallback, useEffect, useState } from 'react';
import { useOutletContext, useParams } from 'react-router-dom';
import { api } from './api';
import { useProjectStream } from './stream';
import type { Board, DeltaCell, ProjectDetail, PushRow, StreamMessage, TestState, YardArea, YardCell } from './types';
import { Modal, Pill } from './ui';
import { Wizard } from './Wizard';

type Context = { project: ProjectDetail | null; refresh: () => void };
const INTERVALS = [5, 10, 20, 30, 60];

export function BoardPage() {
  const { id } = useParams();
  const { refresh } = useOutletContext<Context>();
  const [board, setBoard] = useState<Board | null>(null);
  const [areaIndex, setAreaIndex] = useState(0);
  const [rows, setRows] = useState<PushRow[]>([]);
  const [action, setAction] = useState('');
  const [cell, setCell] = useState<{ area: YardArea; cell: YardCell } | null>(null);
  const [photo, setPhoto] = useState<{ area: YardArea; cell: YardCell; layer: number } | null>(null);
  const [simulate, setSimulate] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [feedback, setFeedback] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [intervalSec, setIntervalSec] = useState(20);
  const [intent, setIntent] = useState<'running' | 'stopped' | null>(null);
  const [pending, setPending] = useState<'start' | 'stop' | ''>('');

  const loadBoard = useCallback(async (sandbox: 0 | 1) => {
    if (!id) return;
    const next = await api<Board>(`/api/projects/${id}/board?sandbox=${sandbox}`);
    if (next) setBoard(next);
  }, [id]);

  const loadPushes = useCallback(async (sandbox: 0 | 1, nextAction = action) => {
    if (!id) return;
    const page = await api<{ items: PushRow[] }>(`/api/projects/${id}/events?sandbox=${sandbox}&action=${encodeURIComponent(nextAction)}&limit=30`);
    setRows(page.items);
  }, [action, id]);

  useEffect(() => {
    if (!id) return;
    void api<ProjectDetail>(`/api/projects/${id}`).then((project) => {
      const sandbox = project.test.viewing ? 1 : 0;
      return Promise.all([loadBoard(sandbox), loadPushes(sandbox)]);
    });
  }, [id, loadBoard, loadPushes]);

  useEffect(() => {
    setIntent(null);
  }, [id]);

  const serverInterval = board?.test.intervalSec;
  useEffect(() => {
    if (!id || board?.id === undefined || String(board.id) !== id) return;
    setIntervalSec(serverInterval || 20);
  }, [board?.id, id, serverInterval]);

  useEffect(() => {
    if (!board?.test.running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [board?.test.running]);

  const onStream = useCallback((incoming: StreamMessage) => {
    if (incoming.type === 'reload') {
      if (incoming.test && !incoming.test.running) setIntent('stopped');
      const sandbox = incoming.test?.viewing ? 1 : board?.sandbox ?? 0;
      void loadBoard(sandbox);
      void loadPushes(sandbox);
      return;
    }
    setBoard((current) => {
      if (!current || incoming.sandbox !== current.sandbox) return current;
      if (incoming.version > current.version + 1) {
        void loadBoard(incoming.sandbox);
        return current;
      }
      const patched = patchBoard(current, incoming.version, incoming.cells, incoming.test, incoming.lastReal);
      if (intent === 'stopped') return { ...patched, test: { ...patched.test, running: false, nextAt: 0 } };
      return patched;
    });
    if (board && incoming.sandbox === board.sandbox) void loadPushes(incoming.sandbox);
  }, [board, intent, loadBoard, loadPushes]);

  useProjectStream(id, onStream);

  async function start() {
    if (pending || !id) return;
    setPending('start');
    setFeedback(null);
    try {
      const result = await api<{ test: TestState }>(`/api/projects/${id}/test/start`, {
        method: 'POST',
        body: JSON.stringify({ intervalSec }),
      });
      setIntent('running');
      if (result?.test) setBoard((current) => current ? { ...current, sandbox: 1, test: { ...current.test, ...result.test } } : current);
      await loadBoard(1);
      await loadPushes(1);
      setFeedback({ tone: 'ok', text: `测试已开启，每 ${result?.test?.intervalSec ?? intervalSec} 秒生成 1 条。` });
      refresh();
    } catch (reason) {
      setIntent(null);
      setFeedback({ tone: 'error', text: reason instanceof Error ? reason.message : '无法开启测试' });
    } finally {
      setPending('');
    }
  }

  async function stop() {
    if (pending || !id) return;
    setPending('stop');
    setIntent('stopped');
    setFeedback({ tone: 'ok', text: '正在关闭测试…' });
    setBoard((current) => current ? { ...current, test: { ...current.test, running: false, nextAt: 0, viewing: true } } : current);
    try {
      const result = await api<{ test: TestState }>(`/api/projects/${id}/test/stop`, { method: 'POST' });
      if (result?.test) {
        setBoard((current) => current ? { ...current, test: { ...current.test, ...result.test, running: false, nextAt: 0 } } : current);
      }
      await loadPushes(1);
      setFeedback({ tone: 'ok', text: '测试已关闭，不再生成新数据。' });
      refresh();
    } catch (reason) {
      setIntent(null);
      setFeedback({ tone: 'error', text: reason instanceof Error ? reason.message : '无法关闭测试' });
      await loadBoard(1);
    } finally {
      setPending('');
    }
  }

  async function leave() {
    setIntent(null);
    setFeedback(null);
    await api(`/api/projects/${id}/test/view`, { method: 'POST', body: JSON.stringify({ viewing: false }) });
    await loadBoard(0);
    await loadPushes(0);
    refresh();
  }

  if (!board) return <p className="subtle">正在读取棋盘…</p>;
  const area = board.areas[areaIndex] ?? board.areas[0];
  const running = intent === 'running' ? true : intent === 'stopped' ? false : board.test.running;
  const every = board.test.intervalSec || intervalSec;
  const countdown = Math.max(0, Math.ceil(((board.test.nextAt || 0) - now) / 1000));
  const intervalChoices = INTERVALS.includes(intervalSec) ? INTERVALS : [intervalSec, ...INTERVALS].sort((left, right) => left - right);

  return (
    <div>
      <div className="crumb">项目总览 / {board.name} / 项目看板</div>
      <div className="pagehead">
        <div>
          <h1>项目看板</h1>
          <p>按区域查看存梁位置、层数和存取记录。棋盘反映已处理的结果。</p>
        </div>
        {!board.test.viewing ? <button className="btn" onClick={() => setSimulate(true)}>手动模拟上报</button> : null}
      </div>
      <div className="banner">接入状态为未接入。测试数据写在独立沙箱，不改变真实棋盘，也不向客户发送。</div>
      {feedback ? <p className={feedback.tone === 'ok' ? 'form-ok' : 'form-error'}>{feedback.text}</p> : null}
      <section className="panel testbar">
        <strong>模拟测试</strong>
        <Pill tone={running ? 'ok' : 'muted'}>{running ? '测试运行中' : board.test.viewing ? '测试已关闭' : '测试未开启'}</Pill>
        <span className="subtle">
          {running
            ? `每 ${every} 秒 1 条 · 已生成 ${board.test.count} 条 · 下次 ${countdown} 秒`
            : board.test.viewing
              ? `已停止生成 · 已生成 ${board.test.count} 条 · 正在查看测试数据${board.test.lastAction ? ` · 最近 ${board.test.lastAction}` : ''}`
              : '当前不读取真实 MQTT'}
        </span>
        <label className="interval">生成间隔
          <select value={intervalSec} disabled={running || pending !== ''} onChange={(event) => setIntervalSec(Number(event.target.value))}>
            {intervalChoices.map((sec) => <option key={sec} value={sec}>{sec} 秒</option>)}
          </select>
        </label>
        <div className="actions">
          <button className={running ? 'btn small' : 'btn small primary'} disabled={pending !== ''} onClick={() => void (running ? stop() : start())}>
            {pending === 'start' ? '正在开启…' : running ? '关闭测试' : '开启测试'}
          </button>
          {board.test.viewing && !running ? <button className="btn small" disabled={pending !== ''} onClick={() => void leave()}>返回项目数据</button> : null}
        </div>
      </section>
      {board.test.viewing ? <p className="test-note">测试沙箱 · 下面的棋盘、原始记录和推送状态都是模拟结果。</p> : null}
      {area ? (
        <section className="panel">
          <div className="panel-head">
            <div><h2>存梁区域</h2><span className="subtle">每格最多 3 层，0 格保留原坐标</span></div>
            <div className="legend"><span><i className="dot" />空闲</span><span><i className="dot used" />已占用</span><span><i className="dot full" />满层</span><span><i className="dot warn" />待核实</span><span>× 不可存放</span></div>
          </div>
          <div className="tabs">
            {board.areas.map((item, index) => (
              <button key={item.id} className={index === areaIndex ? 'tab active' : 'tab'} onClick={() => setAreaIndex(index)}>{item.code} · {item.name}</button>
            ))}
          </div>
          <div className="metrics">
            <Metric label="有效位置" value={area.stats.total} unit="个" />
            <Metric label="空闲 / 已占用" value={`${area.stats.free} / ${area.stats.used}`} unit="个" />
            <Metric label="已确认存梁层数" value={area.stats.layers} unit="层" />
            <Metric label="状态待核实" value={area.stats.unknown} unit="个" />
          </div>
          <div className="toolbar"><span className="subtle">按文件矩阵展示</span><span className="subtle">设备：{area.devices.map((device) => device.code).join('、') || '—'}</span></div>
          <div className="yard-wrap">
            <div className="yard" style={{ gridTemplateColumns: `repeat(${area.cols}, minmax(148px, 1fr))`, minWidth: Math.max(680, area.cols * 160) }}>
              {area.cells.map((item) => <Slot key={`${item.x}-${item.y}`} cell={item} onOpen={() => setCell({ area, cell: item })} onPhoto={(layer) => setPhoto({ area, cell: item, layer })} />)}
            </div>
          </div>
        </section>
      ) : null}
      <section className="panel">
        <div className="panel-head">
          <div><h2>推送记录</h2><span className="subtle">有效存取才会出现在这里，失败不会回滚棋盘</span></div>
          <label className="subtle">动作
            <select value={action} onChange={(event) => { setAction(event.target.value); if (board) void loadPushes(board.sandbox, event.target.value); }}>
              <option value="">全部</option>
              <option value="存梁">存梁</option>
              <option value="取梁">取梁</option>
            </select>
          </label>
        </div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>事件时间</th><th>区域 / 位置</th><th>动作</th><th>层数变化</th><th>设备 ID</th><th>推送状态</th></tr></thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>{row.time}</td>
                  <td>{row.areaCode} · X{row.x} / Y{row.y}</td>
                  <td>{row.action}</td>
                  <td>{row.beforeLayers} → {row.afterLayers}</td>
                  <td>{row.deviceId}</td>
                  <td><Pill tone="warn">{row.pushStatus}</Pill></td>
                </tr>
              ))}
            </tbody>
          </table>
          {!rows.length ? <div className="empty">暂无记录。开启测试或手动模拟后可以在这里查看。</div> : null}
        </div>
      </section>
      {cell ? <CellDialog area={cell.area} cell={cell.cell} onClose={() => setCell(null)} onPhoto={(layer) => { setPhoto({ area: cell.area, cell: cell.cell, layer }); }} /> : null}
      {photo ? <PhotoDialog area={photo.area} cell={photo.cell} layer={photo.layer} onClose={() => setPhoto(null)} /> : null}
      {simulate && id ? <SimulateDialog id={id} areas={board.areas} onClose={() => setSimulate(false)} onDone={async () => { await loadBoard(0); await loadPushes(0); refresh(); }} /> : null}
    </div>
  );
}

function patchBoard(board: Board, version: number, cells: DeltaCell[], test: Board['test'], lastReal: Board['lastReal']): Board {
  if (version < board.version) return board;
  const areas = board.areas.map((area) => {
    const changes = cells.filter((item) => item.areaId === area.id);
    if (!changes.length) return area;
    const nextCells = area.cells.map((item) => {
      const change = changes.find((entry) => entry.x === item.x && entry.y === item.y);
      return change ? { ...item, layers: change.layers, unknown: change.unknown, issue: change.issue, last: change.last, photos: change.photos } : item;
    });
    return { ...area, cells: nextCells, stats: statsOf(nextCells) };
  });
  return { ...board, version, areas, test: { ...board.test, ...test }, lastReal };
}

function statsOf(cells: YardCell[]) {
  const valid = cells.filter((cell) => !cell.invalid);
  return {
    total: valid.length,
    free: valid.filter((cell) => !cell.unknown && cell.layers === 0).length,
    used: valid.filter((cell) => !cell.unknown && cell.layers > 0).length,
    unknown: valid.filter((cell) => cell.unknown).length,
    layers: valid.reduce((sum, cell) => sum + cell.layers, 0),
  };
}

function Slot(props: { cell: YardCell; onOpen: () => void; onPhoto: (layer: number) => void }) {
  const { cell } = props;
  const label = cell.invalid ? '不可存放' : cell.unknown ? '待核实' : cell.layers === 0 ? '空闲' : cell.layers === 3 ? '满层' : '已占用';
  return (
    <div className={cell.invalid ? 'slot disabled' : 'slot'}>
      <div className="slot-head">
        <button className="link" onClick={props.onOpen}>X{cell.x} · Y{cell.y}</button>
        <Pill tone={cell.unknown ? 'warn' : cell.layers ? 'ok' : 'muted'}>{label}</Pill>
      </div>
      {cell.invalid ? <div className="blocked">×<br />不可存放</div> : cell.unknown ? <div className="blocked">初始状态未核实</div> : (
        <div className="layers">
          {[3, 2, 1].map((layer) => {
            const occupied = cell.layers >= layer;
            return (
              <button key={layer} className={occupied ? 'layer on' : 'layer'} disabled={!occupied} onClick={() => props.onPhoto(layer)}>
                <b>{layer}层</b>
                <span>{occupied ? '照片示意' : '空闲'}</span>
              </button>
            );
          })}
        </div>
      )}
      {cell.issue ? <div className="slot-issue">存在待核实上报</div> : null}
    </div>
  );
}

function CellDialog(props: { area: YardArea; cell: YardCell; onClose: () => void; onPhoto: (layer: number) => void }) {
  const { cell } = props;
  const label = cell.invalid ? '不可存放' : cell.unknown ? '初始状态待核实' : cell.layers ? `已占用 ${cell.layers} 层` : '空闲';
  return (
    <Modal title={`位置详情 · X${cell.x} / Y${cell.y}`} onClose={props.onClose}>
      <div className="facts">
        <span>所属区域</span><span>{props.area.code} · {props.area.name}</span>
        <span>当前位置</span><span>X {cell.x} 排 / Y {cell.y} 列</span>
        <span>位置状态</span><span>{label}</span>
        <span>最近存取时间</span><span>{cell.last ?? '—'}</span>
      </div>
      {!cell.invalid && !cell.unknown ? (
        <div className="layers dialog-layers">
          {[3, 2, 1].map((layer) => (
            <button key={layer} className={cell.layers >= layer ? 'layer on' : 'layer'} disabled={cell.layers < layer} onClick={() => props.onPhoto(layer)}>
              <b>{layer}层</b><span>{cell.layers >= layer ? '查看照片示意' : '空闲'}</span>
            </button>
          ))}
        </div>
      ) : null}
    </Modal>
  );
}

function PhotoDialog(props: { area: YardArea; cell: YardCell; layer: number; onClose: () => void }) {
  const photo = props.cell.photos.find((item) => item.layer === props.layer);
  return (
    <Modal title={`${props.area.code} · X${props.cell.x} / Y${props.cell.y} · ${props.layer}层`} onClose={props.onClose}>
      <div className="photo-large"><div><b>照片示意</b><p>设备协议未定，这里不展示真实图片。</p></div></div>
      <div className="facts">
        <span>关联时间</span><span>{photo?.time ?? props.cell.last ?? '—'}</span>
        <span>事件 ID</span><span>{photo?.eventId ?? '—'}</span>
      </div>
    </Modal>
  );
}

function SimulateDialog(props: { id: string; areas: YardArea[]; onClose: () => void; onDone: () => Promise<void> }) {
  const devices = props.areas.flatMap((area) => area.devices.map((device) => ({ ...device, area })));
  const [deviceId, setDeviceId] = useState(devices[0]?.code ?? '');
  const [action, setAction] = useState('存梁');
  const [x, setX] = useState(1);
  const [y, setY] = useState(1);
  const [eventId, setEventId] = useState(`DEMO-${Date.now()}`);
  const [error, setError] = useState('');
  const [result, setResult] = useState('');

  async function run() {
    setError('');
    try {
      const response = await api<{ status: string; reason: string }>(`/api/projects/${props.id}/simulate`, {
        method: 'POST',
        body: JSON.stringify({ deviceId, action, x, y, eventId }),
      });
      setResult(`${response.status} · ${response.reason}`);
      if (response.status === '已处理' || response.status === '异常' || response.status === '重复' || response.status === '待核实') {
        await props.onDone();
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '模拟失败');
    }
  }

  return (
    <Modal title="模拟设备上报" onClose={props.onClose} footer={<><button className="btn" onClick={props.onClose}>关闭</button><button className="btn primary" onClick={() => void run()}>生成模拟上报</button></>}>
      <div className="notice warning">这条记录写入当前项目数据，但来源是手动模拟，不会把项目标成已接入，也不会外发。</div>
      <div className="fields">
        <label>龙门吊
          <select value={deviceId} onChange={(event) => setDeviceId(event.target.value)}>
            {devices.map((device) => <option key={device.code} value={device.code}>{device.name} · {device.code} / {device.area.code}</option>)}
          </select>
        </label>
        <label>存取动作
          <select value={action} onChange={(event) => setAction(event.target.value)}><option>存梁</option><option>取梁</option></select>
        </label>
        <label>X 排<input type="number" min={1} value={x} onChange={(event) => setX(Number(event.target.value))} /></label>
        <label>Y 列<input type="number" min={1} value={y} onChange={(event) => setY(Number(event.target.value))} /></label>
        <label className="full">事件 ID<input value={eventId} onChange={(event) => setEventId(event.target.value)} /></label>
      </div>
      {error ? <p className="form-error">{error}</p> : null}
      {result ? <p>{result}</p> : null}
    </Modal>
  );
}

function Metric(props: { label: string; value: number | string; unit: string }) {
  return <div className="metric"><span>{props.label}</span><strong>{props.value}<small>{props.unit}</small></strong></div>;
}

export function InfoPage() {
  const { project, refresh } = useOutletContext<Context>();
  const [editing, setEditing] = useState(false);
  if (!project) return <p className="subtle">正在读取项目…</p>;
  return (
    <div>
      <div className="crumb">项目总览 / {project.name} / 项目信息</div>
      <div className="pagehead">
        <div><h1>项目信息</h1><p>项目配置、设备映射和棋盘文件。密码与密钥不会回显。</p></div>
        <button className="btn" onClick={() => setEditing(true)}>编辑项目</button>
      </div>
      <section className="panel">
        <div className="panel-head"><h2>基本信息</h2></div>
        <div className="facts">
          <span>项目名称</span><span>{project.name}</span>
          <span>项目编码</span><span>{project.code}</span>
          <span>备注</span><span>{project.note || '—'}</span>
          <span>接入状态</span><span>{project.testRunning ? '测试运行中' : '未接入'}</span>
        </div>
      </section>
      <section className="panel">
        <div className="panel-head"><h2>保存时长与接口</h2></div>
        <div className="facts">
          <span>原始 / 事件 / 照片 / 推送 / 日志</span>
          <span>{['raw', 'event', 'photo', 'push', 'log'].map((key) => project.retention[key as 'raw'] ?? '待确认').join(' / ')} 天</span>
          <span>MQTT Broker</span><span>{project.mqtt.broker || '待确认'}</span>
          <span>订阅 Topic</span><span>{project.mqtt.topic || '待确认'}</span>
          <span>MQTT 用户名</span><span>{project.mqtt.username || '—'}</span>
          <span>MQTT 密码</span><span>{project.mqtt.hasPassword ? '已填写（隐藏）' : '未填写'}</span>
          <span>客户推送地址</span><span>{project.customer.endpoint || '未配置'}</span>
          <span>鉴权 / 重试</span><span>{project.customer.auth || '未确认'} / {project.customer.retry ?? '待确认'}</span>
          <span>AppSecret</span><span>{project.customer.hasSecret ? '已填写（隐藏）' : '未填写'}</span>
          <span>推送开关</span><span>未启用 · 不会实际发送</span>
        </div>
      </section>
      <section className="panel">
        <div className="panel-head"><h2>区域与龙门吊</h2></div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>区域 ID</th><th>区域名称</th><th>龙门吊 ID</th><th>龙门吊名称</th></tr></thead>
            <tbody>
              {project.areas.flatMap((area) => area.devices.map((device) => (
                <tr key={device.code}><td>{area.code}</td><td>{area.name}</td><td>{device.code}</td><td>{device.name}</td></tr>
              )))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="panel">
        <div className="panel-head"><h2>棋盘文件</h2></div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>区域</th><th>文件名</th><th>规模</th><th>有效位置</th><th>不可存放</th></tr></thead>
            <tbody>
              {project.areas.map((area) => {
                const valid = area.matrix.flat().filter((bit) => bit === 1).length;
                return <tr key={area.id}><td>{area.code} · {area.name}</td><td>{area.filename}</td><td>{area.rows} × {area.cols}</td><td>{valid}</td><td>{area.matrix.flat().length - valid}</td></tr>;
              })}
            </tbody>
          </table>
        </div>
      </section>
      {editing ? <Wizard mode="edit" id={project.id} onClose={() => setEditing(false)} onDone={() => { setEditing(false); refresh(); }} /> : null}
    </div>
  );
}

export function RawPage() {
  const { id } = useParams();
  const [status, setStatus] = useState('');
  const [sandbox, setSandbox] = useState<0 | 1>(0);
  const [rows, setRows] = useState<import('./types').RawRow[]>([]);
  const [selected, setSelected] = useState<import('./types').RawRow | null>(null);

  const load = useCallback(async (nextStatus = status, nextSandbox = sandbox) => {
    const page = await api<{ items: import('./types').RawRow[] }>(`/api/projects/${id}/raw?sandbox=${nextSandbox}&status=${encodeURIComponent(nextStatus)}&limit=40`);
    setRows(page.items);
  }, [id, sandbox, status]);

  useEffect(() => {
    void api<ProjectDetail>(`/api/projects/${id}`).then((project) => {
      const next = project.test.viewing ? 1 : 0;
      setSandbox(next);
      return load(status, next);
    });
  }, [id]);

  useProjectStream(id, () => { void load(); });

  return (
    <div>
      <div className="crumb">原始数据监控</div>
      <div className="pagehead"><div><h1>原始数据监控</h1><p>只读查看上报原文和处理结果。异常记录会保留。</p></div></div>
      <div className="banner">{sandbox === 1 ? '当前显示测试沙箱中的模拟报文，不是设备协议。' : '真实 MQTT 尚未接入。手动模拟会产生来源为 MANUAL 的记录。'}</div>
      <section className="panel">
        <div className="panel-head">
          <h2>设备上报记录</h2>
          <label className="subtle">处理结果
            <select value={status} onChange={(event) => { setStatus(event.target.value); void load(event.target.value, sandbox); }}>
              <option value="">全部</option>
              {['已处理', '待核实', '异常', '重复'].map((item) => <option key={item}>{item}</option>)}
            </select>
          </label>
        </div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>接收时间</th><th>设备 ID</th><th>动作</th><th>位置</th><th>处理结果</th><th>原因</th><th></th></tr></thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>{row.receivedAt}</td>
                  <td>{row.deviceId}</td>
                  <td>{row.action}</td>
                  <td>X{row.x} / Y{row.y}</td>
                  <td><Pill tone={row.status === '已处理' ? 'ok' : 'warn'}>{row.status}</Pill></td>
                  <td>{row.reason}</td>
                  <td><button className="link" onClick={() => setSelected(row)}>查看原文</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          {!rows.length ? <div className="empty">暂无符合条件的记录</div> : null}
        </div>
      </section>
      {selected ? (
        <Modal title="原始上报详情" onClose={() => setSelected(null)}>
          <div className="facts"><span>处理结果</span><span>{selected.status} · {selected.reason}</span><span>来源</span><span>{selected.source}</span></div>
          <pre className="pre">{JSON.stringify(selected.payload, null, 2)}</pre>
        </Modal>
      ) : null}
    </div>
  );
}

export function LogsPage() {
  const { id } = useParams();
  const [rows, setRows] = useState<import('./types').LogRow[]>([]);
  useEffect(() => {
    void api<{ items: import('./types').LogRow[] }>(`/api/projects/${id}/logs?limit=50`).then((page) => setRows(page.items));
  }, [id]);
  return (
    <div>
      <div className="crumb">系统日志</div>
      <div className="pagehead"><div><h1>系统日志</h1><p>这里只记录用户操作。设备异常看原始数据，推送结果看项目看板。</p></div></div>
      <section className="panel">
        <div className="table-wrap">
          <table>
            <thead><tr><th>时间</th><th>操作者</th><th>操作</th><th>对象</th><th>结果</th></tr></thead>
            <tbody>{rows.map((row) => <tr key={row.id}><td>{row.time}</td><td>{row.actor}</td><td>{row.action}</td><td>{row.object}</td><td>{row.result}</td></tr>)}</tbody>
          </table>
          {!rows.length ? <div className="empty">暂无操作日志</div> : null}
        </div>
      </section>
    </div>
  );
}
