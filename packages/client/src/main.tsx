import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { applyTheme } from './lib/theme';
import { keepUpToDate } from './lib/update';
import { fitShortViewport, pinViewport } from './lib/viewport';
import './index.css';

applyTheme();
pinViewport();
fitShortViewport();
keepUpToDate();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
