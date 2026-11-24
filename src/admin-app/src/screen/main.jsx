import React from 'react';
import { createRoot } from 'react-dom/client';
import ScreenApp from './ScreenApp.jsx';
import './screen.css';

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ScreenApp />
  </React.StrictMode>,
);
