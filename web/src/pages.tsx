import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from './api';
import type { Card } from './types';
import { Modal, Pill } from './ui';
import { Wizard } from './Wizard';

type WizardState = { mode: 'create' | 'edit' | 'copy'; id?: number } | null;

export function Projects() {
  const navigate = useNavigate();
  const [cards, setCards] = useState<Card[]>([]);
  const [query, setQuery] = useState('');
  const [name, setName] = useState('');
  const [wizard, setWizard] = useState<WizardState>(null);
  const [removing, setRemoving] = useState<Card | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');

  async function load() {
    const list = await api<Card[]>('/api/projects');
    setCards(list);
  }

  useEffect(() => {
    void api<{ name: string }>('/api/auth/me').then((user) => setName(user.name));
    void load();
  }, []);

  const shown = cards.filter((card) => `${card.code} ${card.name}`.toLowerCase().includes(query.trim().toLowerCase()));

  async function confirmDelete() {
    if (!removing) return;
    setError('');
    try {
      await api(`/api/projects/${removing.id}`, { method: 'DELETE', body: JSON.stringify({ code }) });
      setRemoving(null);
      setCode('');
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '删除失败');
    }
  }

  return (
    <div className="app">
      <Topbar name={name} />
      <main className="page">
        <div className="hero">
          <div>
            <span className="eyebrow">PROJECTS / 项目总览</span>
            <h1>项目看板</h1>
            <p>管理梁仓项目，查看接入状态和最近一次存取。</p>
          </div>
          <button className="btn primary" onClick={() => setWizard({ mode: 'create' })}>新建项目</button>
        </div>
        <div className="banner">当前使用虚拟数据验证存取。MQTT 尚未接入，页面不会把测试显示成设备已连接。</div>
        <input className="search" aria-label="搜索项目" placeholder="搜索项目名称或编码" value={query} onChange={(event) => setQuery(event.target.value)} />
        <div className="project-grid">
          {shown.map((card) => (
            <article className="project-card" key={card.id}>
              <div className="card-top">
                <strong>{card.code}</strong>
                <Pill tone={card.testRunning ? 'ok' : 'warn'}>{card.testRunning ? '测试运行中' : '未接入'}</Pill>
              </div>
              <h2>{card.name}</h2>
              <div className="meta">
                <div><b>{card.areaCount}</b>存梁区域</div>
                <div><b>{card.deviceCount}</b>龙门吊</div>
                <div><b>{card.validCount}</b>有效位置</div>
              </div>
              <p className="subtle">最近真实存取：{card.lastReal ? `${card.lastReal.time} · ${card.lastReal.action} · ${card.lastReal.area} X${card.lastReal.x} Y${card.lastReal.y}` : '—'}</p>
              <p className="subtle">最近测试操作：{card.lastTest ? `${card.lastTest.time} · ${card.lastTest.action}` : '—'}</p>
              <div className="actions split">
                <button className="btn small" onClick={() => navigate(`/projects/${card.id}/board`)}>进入项目</button>
                <button className="btn small" onClick={() => setWizard({ mode: 'edit', id: card.id })}>编辑</button>
                <button className="btn small" onClick={() => setWizard({ mode: 'copy', id: card.id })}>复制</button>
                <button className="btn small danger" onClick={() => { setRemoving(card); setCode(''); setError(card.testRunning ? '测试运行中，请进入项目关闭测试后再删除。' : ''); }}>删除</button>
              </div>
            </article>
          ))}
          <button className="new-card" onClick={() => setWizard({ mode: 'create' })}><b>＋ 新建项目</b><span>基本信息、映射与棋盘</span></button>
        </div>
        {!shown.length ? <div className="empty">没有匹配的项目。</div> : null}
      </main>
      {wizard ? (
        <Wizard
          mode={wizard.mode}
          id={wizard.id}
          onClose={() => setWizard(null)}
          onDone={(id) => {
            setWizard(null);
            if (wizard.mode === 'edit') void load();
            else navigate(`/projects/${id}/board`);
          }}
        />
      ) : null}
      {removing ? (
        <Modal
          title="删除项目"
          onClose={() => setRemoving(null)}
          footer={<><button className="btn" onClick={() => setRemoving(null)}>取消</button><button className="btn danger" onClick={() => void confirmDelete()} disabled={removing.testRunning}>确认删除</button></>}
        >
          <div className="notice warning">删除会移除该项目的配置、棋盘和存取记录。此操作需要输入项目编码确认。</div>
          <p>请输入项目编码 <strong>{removing.code}</strong> 以删除「{removing.name}」。</p>
          <input aria-label="确认项目编码" value={code} onChange={(event) => setCode(event.target.value)} />
          {error ? <p className="form-error">{error}</p> : null}
        </Modal>
      ) : null}
    </div>
  );
}

export function Topbar(props: { name: string }) {
  const navigate = useNavigate();
  return (
    <header className="topbar">
      <div className="brand"><span className="mark" />梁仓存取看板</div>
      <div className="top-actions">
        <span className="subtle">{props.name}</span>
        <button className="btn small" onClick={() => { void api('/api/auth/logout', { method: 'POST' }).then(() => navigate('/login')); }}>退出</button>
      </div>
    </header>
  );
}

export function Login() {
  const navigate = useNavigate();
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    api('/api/auth/me').then(() => navigate('/')).catch(() => undefined);
  }, [navigate]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError('');
    try {
      await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) });
      navigate('/');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '登录失败');
    }
  }

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={(event) => void submit(event)}>
        <div className="brand"><span className="mark" />梁仓存取看板</div>
        <h1>管理员登录</h1>
        <p className="subtle">默认账号 admin，初始密码 admin123。请在正式使用前更换。</p>
        <label>账号<input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" /></label>
        <label>密码<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" /></label>
        {error ? <p className="form-error">{error}</p> : null}
        <button className="btn primary" type="submit">登录</button>
      </form>
    </div>
  );
}
