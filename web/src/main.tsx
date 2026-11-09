import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { applyAvatarMotion } from './components/Avatar.tsx';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';
import { actions } from './state.ts';
import './styles.css';
import { lockViewport } from './viewport.ts';

const unlockViewport = lockViewport();
if (import.meta.hot) import.meta.hot.dispose(unlockViewport);

applyAvatarMotion();
void actions.init();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
