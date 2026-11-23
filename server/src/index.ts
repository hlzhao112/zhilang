import { initApp } from './repo.js';
import { buildServer } from './server.js';

initApp();
const port = Number(process.env.PORT || 8787);
const app = buildServer();
await app.listen({ port, host: '127.0.0.1' });
console.log(`梁仓存取看板接口已启动 http://127.0.0.1:${port}`);
console.log('开发页面请打开 http://localhost:5173');
