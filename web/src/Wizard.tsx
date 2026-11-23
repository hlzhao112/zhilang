import { useEffect, useState } from 'react';
import { ApiError, api } from './api';
import type { AreaDetail, ProjectDetail } from './types';
import { Modal } from './ui';

type Mode = 'create' | 'edit' | 'copy';

type AreaDraft = {
  code: string;
  name: string;
  filename: string;
  devices: { code: string; name: string }[];
  rows: number;
  cols: number;
  matrix: number[][] | null;
};

type Draft = {
  mode: Mode;
  id?: number;
  code: string;
  name: string;
  note: string;
  mappingName: string;
  rawDays: string;
  eventDays: string;
  photoDays: string;
  pushDays: string;
  logDays: string;
  broker: string;
  topic: string;
  mqttUser: string;
  mqttSecret: string;
  offline: string;
  endpoint: string;
  auth: '' | '无鉴权' | 'Token';
  token: string;
  appid: string;
  secret: string;
  retry: string;
  areas: AreaDraft[];
};

const emptyDraft = (mode: Mode, id?: number): Draft => ({
  mode,
  id,
  code: '',
  name: '',
  note: '',
  mappingName: '',
  rawDays: '',
  eventDays: '',
  photoDays: '',
  pushDays: '',
  logDays: '',
  broker: '',
  topic: '',
  mqttUser: '',
  mqttSecret: '',
  offline: '',
  endpoint: '',
  auth: '',
  token: '',
  appid: '',
  secret: '',
  retry: '',
  areas: [],
});

function fromProject(project: ProjectDetail, mode: Mode): Draft {
  const num = (value: number | null) => (value == null ? '' : String(value));
  return {
    ...emptyDraft(mode, project.id),
    code: mode === 'copy' ? '' : project.code,
    name: mode === 'copy' ? `${project.name}-副本`.slice(0, 40) : project.name,
    note: project.note,
    mappingName: project.mappingName,
    rawDays: num(project.retention.raw),
    eventDays: num(project.retention.event),
    photoDays: num(project.retention.photo),
    pushDays: num(project.retention.push),
    logDays: num(project.retention.log),
    broker: project.mqtt.broker,
    topic: project.mqtt.topic,
    mqttUser: project.mqtt.username,
    offline: num(project.mqtt.offlineMinutes),
    endpoint: project.customer.endpoint,
    auth: project.customer.auth === 'Token' || project.customer.auth === '无鉴权' ? project.customer.auth : '',
    token: project.customer.tokenUrl,
    appid: project.customer.appId,
    retry: num(project.customer.retry),
    areas: project.areas.map(areaDraft),
  };
}

function areaDraft(area: AreaDetail): AreaDraft {
  return {
    code: area.code,
    name: area.name,
    filename: area.filename,
    devices: area.devices,
    rows: area.rows,
    cols: area.cols,
    matrix: area.matrix,
  };
}

function payload(draft: Draft) {
  const optional = (value: string) => (value.trim() === '' ? null : Number(value));
  return {
    code: draft.code.trim(),
    name: draft.name.trim(),
    note: draft.note.trim(),
    mappingName: draft.mappingName,
    retention: {
      raw: optional(draft.rawDays),
      event: optional(draft.eventDays),
      photo: optional(draft.photoDays),
      push: optional(draft.pushDays),
      log: optional(draft.logDays),
    },
    mqtt: {
      broker: draft.broker.trim(),
      topic: draft.topic.trim(),
      username: draft.mqttUser.trim(),
      password: draft.mqttSecret,
      offlineMinutes: optional(draft.offline),
    },
    customer: {
      endpoint: draft.endpoint.trim(),
      auth: draft.auth,
      tokenUrl: draft.token.trim(),
      appId: draft.appid.trim(),
      appSecret: draft.secret,
      retry: optional(draft.retry),
    },
    areas: draft.areas.map((area) => ({
      code: area.code,
      name: area.name,
      filename: area.filename,
      devices: area.devices,
      rows: area.rows,
      cols: area.cols,
      matrix: area.matrix,
    })),
  };
}

export function Wizard(props: { mode: Mode; id?: number; onClose: () => void; onDone: (id: number) => void }) {
  const [draft, setDraft] = useState<Draft>(() => emptyDraft(props.mode, props.id));
  const [step, setStep] = useState(1);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

  useEffect(() => {
    if (props.mode === 'create' || !props.id) return;
    let stop = false;
    api<ProjectDetail>(`/api/projects/${props.id}`).then((project) => {
      if (!stop) setDraft(fromProject(project, props.mode));
    }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : '项目读取失败'));
    return () => { stop = true; };
  }, [props.id, props.mode]);

  const title = props.mode === 'edit' ? '编辑项目' : props.mode === 'copy' ? '复制项目' : '新建项目';

  async function uploadMapping(file: File) {
    setError('');
    const body = new FormData();
    body.append('file', file);
    try {
      const parsed = await api<{ filename: string; areas: { code: string; name: string; devices: { code: string; name: string }[] }[] }>('/api/parse/mapping', { method: 'POST', body });
      setDraft((current) => ({
        ...current,
        mappingName: parsed.filename,
        areas: parsed.areas.map((area) => ({ ...area, filename: '', rows: 0, cols: 0, matrix: null })),
      }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '映射表读取失败');
    }
  }

  async function useSampleMapping() {
    setError('');
    const parsed = await api<{ filename: string; areas: { code: string; name: string; devices: { code: string; name: string }[] }[] }>('/api/samples/mapping');
    setDraft((current) => ({
      ...current,
      mappingName: parsed.filename,
      areas: parsed.areas.map((area) => ({ ...area, filename: '', rows: 0, cols: 0, matrix: null })),
    }));
  }

  async function uploadBoard(index: number, file: File) {
    const area = draft.areas[index];
    const body = new FormData();
    body.append('file', file);
    try {
      const parsed = await api<{ filename: string; rows: number; cols: number; matrix: number[][] }>(`/api/parse/board?areaCode=${encodeURIComponent(area.code)}`, { method: 'POST', body });
      setArea(index, { filename: parsed.filename, rows: parsed.rows, cols: parsed.cols, matrix: parsed.matrix });
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '棋盘读取失败');
    }
  }

  async function useSampleBoard(index: number) {
    const area = draft.areas[index];
    try {
      const parsed = await api<{ filename: string; rows: number; cols: number; matrix: number[][] }>(`/api/samples/board/${encodeURIComponent(area.code)}`);
      setArea(index, { filename: parsed.filename, rows: parsed.rows, cols: parsed.cols, matrix: parsed.matrix });
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '没有对应的示例棋盘');
    }
  }

  function setArea(index: number, patch: Partial<AreaDraft>) {
    setDraft((current) => ({
      ...current,
      areas: current.areas.map((area, i) => (i === index ? { ...area, ...patch } : area)),
    }));
  }

  function validateStep() {
    if (step === 1) {
      if (!draft.code.trim() || !draft.name.trim()) return '请填写项目编码和项目名称';
      if (!/^[A-Za-z0-9]+$/.test(draft.code.trim())) return '项目编码仅支持英文和数字';
    }
    if (step === 2 && (!draft.areas.length || draft.areas.some((area) => !area.matrix))) return '请先上传映射表并完成所有区域的棋盘配置';
    return '';
  }

  async function submit(clearTest = false) {
    setBusy(true);
    setError('');
    try {
      if (draft.mode === 'edit' && draft.id) {
        await api(`/api/projects/${draft.id}`, { method: 'PUT', body: JSON.stringify({ ...payload(draft), clearTest }) });
        props.onDone(draft.id);
      } else {
        const created = await api<{ id: number }>('/api/projects', { method: 'POST', body: JSON.stringify(payload(draft)) });
        props.onDone(created.id);
      }
    } catch (reason) {
      if (reason instanceof ApiError && reason.code === 'NEED_CLEAR_TEST') {
        setConfirmClear(true);
      } else {
        setError(reason instanceof Error ? reason.message : '保存失败');
      }
    } finally {
      setBusy(false);
    }
  }

  async function next() {
    const message = validateStep();
    if (message) {
      setError(message);
      return;
    }
    setError('');
    if (step < 3) setStep(step + 1);
    else await submit(false);
  }

  const deviceCount = draft.areas.reduce((sum, area) => sum + area.devices.length, 0);

  return (
    <Modal
      title={title}
      onClose={props.onClose}
      footer={
        <>
          <button className="btn" onClick={props.onClose}>取消</button>
          {step > 1 ? <button className="btn" onClick={() => { setError(''); setStep(step - 1); }}>上一步</button> : null}
          <button className="btn primary" disabled={busy} onClick={() => void next()}>{step === 3 ? (draft.mode === 'edit' ? '保存修改' : '确认创建') : '下一步'}</button>
        </>
      }
    >
      <div className="steps">
        {['项目配置', '导入文件', '确认'].map((label, index) => (
          <span key={label} className={step === index + 1 ? 'current' : ''}>{index + 1}. {label}</span>
        ))}
      </div>
      {step === 1 ? <ConfigStep draft={draft} setDraft={setDraft} /> : null}
      {step === 2 ? (
        <div className="stack-gap">
          <div className="notice">先导入区域–龙门吊映射，再为每个区域上传从 A1 开始的纯数字矩阵。1 可存放，0 不可存放，0 格会保留在原位。</div>
          <div className="uploadbox">
            <strong>1. 区域–龙门吊映射表</strong>
            <p className="subtle">表头为区域ID、区域名称、龙门吊ID、龙门吊名称。表头末尾空格会自动去掉。</p>
            <div className="actions">
              <input aria-label="上传区域龙门吊映射表" type="file" accept=".xlsx" onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadMapping(file); }} />
              <button className="btn small" onClick={() => void useSampleMapping()}>使用示例映射</button>
            </div>
            <p className="subtle">{draft.mappingName ? `已读取 ${draft.mappingName} · ${draft.areas.length} 个区域 / ${deviceCount} 台设备` : '尚未读取映射表'}</p>
          </div>
          {draft.areas.length ? draft.areas.map((area, index) => (
            <div className="uploadbox" key={area.code}>
              <strong>{area.code} · {area.name}</strong>
              <span className="subtle"> {area.devices.map((device) => device.code).join('、')}</span>
              <div className="actions">
                <input aria-label={`上传 ${area.code} 棋盘`} type="file" accept=".xlsx" onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadBoard(index, file); }} />
                <button className="btn small" onClick={() => void useSampleBoard(index)}>使用示例棋盘</button>
              </div>
              {area.matrix ? <MatrixPreview area={area} /> : <p className="subtle">尚未上传。文件名需要是 {area.code}.xlsx</p>}
            </div>
          )) : <div className="empty">请先上传映射表。</div>}
        </div>
      ) : null}
      {step === 3 ? (
        <div>
          <div className="notice warning">新建与副本的有效位置初始为空。客户接口即使已填写也不会发送。请勿输入真实密码或密钥。</div>
          <div className="facts">
            <span>项目名称</span><span>{draft.name || '—'}</span>
            <span>项目编码</span><span>{draft.code || '—'}</span>
            <span>区域 / 设备</span><span>{draft.areas.length} / {deviceCount}</span>
            <span>映射文件</span><span>{draft.mappingName || '—'}</span>
            <span>棋盘</span><span>{draft.areas.map((area) => `${area.code}：${area.matrix?.flat().filter((bit) => bit === 1).length ?? 0} 个有效位置`).join('；')}</span>
            <span>客户推送</span><span>{draft.endpoint ? '已填写地址，未启用' : '未配置'}</span>
          </div>
        </div>
      ) : null}
      {error ? <p className="form-error" role="status">{error}</p> : null}
      {confirmClear ? (
        <Modal
          title="清除测试沙箱"
          onClose={() => setConfirmClear(false)}
          footer={<><button className="btn" onClick={() => setConfirmClear(false)}>取消</button><button className="btn primary" onClick={() => { setConfirmClear(false); void submit(true); }}>继续保存</button></>}
        >
          <p>保存编辑会清除本次测试沙箱和测试记录。项目里已经确认的存取数据会保留。</p>
        </Modal>
      ) : null}
    </Modal>
  );
}

function ConfigStep(props: { draft: Draft; setDraft: (value: Draft | ((current: Draft) => Draft)) => void }) {
  const { draft, setDraft } = props;
  const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });
  return (
    <div className="stack-gap">
      <div className="notice">保存时长、MQTT 和客户接口都可以先留空。当前不会连接 MQTT，也不会向客户发送数据。</div>
      <h4>基本信息</h4>
      <div className="fields">
        <label>项目编码 *<input value={draft.code} readOnly={draft.mode === 'edit'} onChange={(event) => set({ code: event.target.value })} placeholder="英文或数字" /></label>
        <label>项目名称 *<input value={draft.name} onChange={(event) => set({ name: event.target.value })} /></label>
        <label className="full">项目备注<textarea rows={2} value={draft.note} onChange={(event) => set({ note: event.target.value })} /></label>
      </div>
      <h4>数据保存时长（天）</h4>
      <p className="subtle">留空表示待确认，不是永久保存。</p>
      <div className="fields">
        <Num label="原始数据" value={draft.rawDays} onChange={(rawDays) => set({ rawDays })} />
        <Num label="存取事件" value={draft.eventDays} onChange={(eventDays) => set({ eventDays })} />
        <Num label="照片" value={draft.photoDays} onChange={(photoDays) => set({ photoDays })} />
        <Num label="推送记录" value={draft.pushDays} onChange={(pushDays) => set({ pushDays })} />
        <Num label="操作日志" value={draft.logDays} onChange={(logDays) => set({ logDays })} />
      </div>
      <h4>设备接入 · MQTT</h4>
      <p className="subtle">只保存配置，协议确定前不会建立连接。</p>
      <div className="fields">
        <label>Broker 地址<input value={draft.broker} onChange={(event) => set({ broker: event.target.value })} placeholder="留空：待确认" /></label>
        <label>订阅 Topic<input value={draft.topic} onChange={(event) => set({ topic: event.target.value })} placeholder="留空：待确认" /></label>
        <label>用户名<input value={draft.mqttUser} onChange={(event) => set({ mqttUser: event.target.value })} /></label>
        <label>密码<input type="password" value={draft.mqttSecret} onChange={(event) => set({ mqttSecret: event.target.value })} placeholder={draft.mode === 'edit' ? '留空不修改' : '请勿输入真实密钥'} /></label>
        <Num label="离线判定阈值（分钟）" value={draft.offline} onChange={(offline) => set({ offline })} />
      </div>
      <h4>客户接口</h4>
      <div className="fields">
        <label className="full">推送地址<input value={draft.endpoint} onChange={(event) => set({ endpoint: event.target.value })} placeholder="https://" /></label>
        <label>鉴权方式
          <select value={draft.auth} onChange={(event) => set({ auth: event.target.value as Draft['auth'] })}>
            <option value="">未确认</option>
            <option value="无鉴权">无鉴权（示例）</option>
            <option value="Token">Token（示例）</option>
          </select>
        </label>
        <Num label="失败重试次数" value={draft.retry} onChange={(retry) => set({ retry })} />
        <label>Token 地址<input value={draft.token} onChange={(event) => set({ token: event.target.value })} /></label>
        <label>AppID<input value={draft.appid} onChange={(event) => set({ appid: event.target.value })} /></label>
        <label>AppSecret<input type="password" value={draft.secret} onChange={(event) => set({ secret: event.target.value })} placeholder={draft.mode === 'edit' ? '留空不修改' : '请勿输入真实密钥'} /></label>
      </div>
    </div>
  );
}

function Num(props: { label: string; value: string; onChange: (value: string) => void }) {
  return <label>{props.label}<input inputMode="numeric" value={props.value} onChange={(event) => props.onChange(event.target.value)} placeholder="留空：待确认" /></label>;
}

function MatrixPreview(props: { area: AreaDraft }) {
  const matrix = props.area.matrix ?? [];
  const valid = matrix.flat().filter((bit) => bit === 1).length;
  const blocked = matrix.flat().length - valid;
  return (
    <div>
      <p className="subtle">{props.area.filename} · {props.area.rows} × {props.area.cols} · 有效 {valid} / 不可存放 {blocked}</p>
      <div className="matrix" style={{ gridTemplateColumns: `repeat(${props.area.cols}, 28px)` }}>
        {matrix.flat().map((bit, index) => <span key={index} className={bit ? 'on' : ''}>{bit}</span>)}
      </div>
    </div>
  );
}
