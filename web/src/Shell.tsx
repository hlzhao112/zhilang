import { useEffect, useState } from 'react';
import { NavLink, Outlet, useNavigate, useParams } from 'react-router-dom';
import { api } from './api';
import type { ProjectDetail } from './types';
import { Topbar } from './pages';

const links = [
  ['board', '项目看板', '1'],
  ['info', '项目信息', '2'],
  ['raw', '原始数据监控', '3'],
  ['logs', '系统日志', '4'],
] as const;

export function Shell() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [who, setWho] = useState('管理员');
  const [stats, setStats] = useState({ queued: 0, processed: 0 });

  useEffect(() => {
    void api<{ name: string }>('/api/auth/me').then((user) => setWho(user.name)).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!id) return;
    void api<ProjectDetail>(`/api/projects/${id}`).then(setProject).catch(() => navigate('/'));
  }, [id, navigate]);

  useEffect(() => {
    const load = () => void api<{ queued: number; processed: number }>('/api/ingest').then(setStats).catch(() => undefined);
    load();
    const timer = setInterval(load, 15000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      const link = links.find((item) => item[2] === event.key);
      if (link && id) navigate(`/projects/${id}/${link[0]}`);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [id, navigate]);

  return (
    <div className="app">
      <Topbar name={who} />
      <div className="shell">
        <aside>
          <button className="link" onClick={() => navigate('/')}>← 返回项目总览</button>
          <div className="caption">{project?.name ?? '加载中'}</div>
          <nav>
            {links.map(([path, label]) => (
              <NavLink key={path} to={`/projects/${id}/${path}`} className={({ isActive }) => isActive ? 'nav active' : 'nav'}>{label}</NavLink>
            ))}
          </nav>
          <div className="sidefoot">
            上报队列 {stats.queued} · 已处理 {stats.processed}
            <br />虚拟数据通道，MQTT 未接入
          </div>
        </aside>
        <main>
          <Outlet context={{ project, refresh: () => id && void api<ProjectDetail>(`/api/projects/${id}`).then(setProject) }} />
        </main>
      </div>
    </div>
  );
}
