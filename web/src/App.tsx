import { useEffect, useState, type ReactNode } from 'react';
import { Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { api } from './api';
import { Login, Projects } from './pages';
import { BoardPage, InfoPage, LogsPage, RawPage } from './project';
import { Shell } from './Shell';

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/" element={<Guard><Projects /></Guard>} />
      <Route path="/projects/:id" element={<Guard><Shell /></Guard>}>
        <Route index element={<Navigate to="board" replace />} />
        <Route path="board" element={<BoardPage />} />
        <Route path="info" element={<InfoPage />} />
        <Route path="raw" element={<RawPage />} />
        <Route path="logs" element={<LogsPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

function Guard(props: { children: ReactNode }) {
  const navigate = useNavigate();
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let stop = false;
    api('/api/auth/me').then(() => { if (!stop) setReady(true); }).catch(() => navigate('/login'));
    return () => { stop = true; };
  }, [navigate]);
  if (!ready) return <p className="boot">正在确认登录状态…</p>;
  return props.children;
}
