import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import ErrorBoundary from './components/ErrorBoundary';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {/* 顶层兜底：App 自身渲染异常时不再白屏，仍可返回看板/重试/刷新 */}
    <ErrorBoundary resetOnHashChange title="系统遇到异常">
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
