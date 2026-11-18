import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles/tokens.css';
import './styles/app.css';

const container = document.getElementById('root');
if (!container) throw new Error('缺少根节点 #root');

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {
      // 注册失败不影响页面本身可用
    });
  });
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
