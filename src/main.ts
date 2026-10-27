import React from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import App from './App';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('The root element was not found.');
}

const root = createRoot(rootElement);
root.render(React.createElement(App));
