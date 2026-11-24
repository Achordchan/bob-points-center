import React from 'react';
import { createRoot } from 'react-dom/client';
import './screen.css';

function GalaScreenApp() {
  return (
    <main className="gala-screen-shell">
      <h1 className="gala-screen-title">年会大屏</h1>
    </main>
  );
}

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <GalaScreenApp />
  </React.StrictMode>,
);
