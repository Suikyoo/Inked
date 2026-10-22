import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/public-sans/400.css';
import '@fontsource/public-sans/500.css';
import '@fontsource/public-sans/600.css';
import '@fontsource/public-sans/700.css';
import '@fontsource/spectral/500-italic.css';
import '@fontsource/spectral/600-italic.css';
import '@fontsource/jetbrains-mono/400.css';
import '../../styles/tokens.css';
import '../../styles/base.css';
import '../../styles/home.css';
import '../../styles/map.css';
import '../../styles/note.css';
import '../../styles/openboard.css';
import '../../styles/openboard-editor.css';
import { EditorPage } from './EditorPage';

// The owner's openboard editor. Deliberately imports no store, crypto or vault keys
// (see scripts/check-openboard-bundle.mjs); it talks to the owner API with the session cookie only.
createRoot(document.getElementById('openboard-root')!).render(
  <StrictMode>
    <EditorPage />
  </StrictMode>,
);
