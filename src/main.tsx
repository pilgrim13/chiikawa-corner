import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { Overlay } from './Overlay';
import './styles.css';

const overlay = new URLSearchParams(location.search).get('view') === 'overlay';
if (overlay) document.documentElement.classList.add('overlay-document');
if (window.corner) document.documentElement.classList.add('desktop-document');
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>{overlay ? <Overlay /> : <App />}</React.StrictMode>,
);
