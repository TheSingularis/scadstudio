import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './monacoEnvironment';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <div style={{ height: '100%' }}>
      <ErrorBoundary label="ScadStudio" onReload={() => window.location.reload()}>
        <App />
      </ErrorBoundary>
    </div>
  </StrictMode>,
);
