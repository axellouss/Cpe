/**
 * Point d'entrée : monte l'application Plan2CPE.
 * La langue du document suit le choix de l'utilisateur (retenu sur ce poste) dès avant le premier rendu.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/index.css';
import { App, getShellStore } from './ui/shell';

const store = getShellStore();
document.documentElement.lang = store.getState().lang;

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App store={store} />
    </StrictMode>,
  );
}
