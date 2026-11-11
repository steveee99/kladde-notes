import '@fontsource-variable/roboto-flex';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { applyTheme } from './lib/theme';
import { justUpdated, keepUpToDate } from './lib/update';
import { fitKeyboardViewport, fitShortViewport, pinViewport, recordStartupReport } from './lib/viewport';
import './index.css';

// After an update the app reappears as it was, without every list fading in again
if (justUpdated()) {
  document.documentElement.classList.add('no-anim');
  setTimeout(() => document.documentElement.classList.remove('no-anim'), 1500);
}
applyTheme();
pinViewport();
fitShortViewport();
fitKeyboardViewport();
recordStartupReport();
keepUpToDate();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
