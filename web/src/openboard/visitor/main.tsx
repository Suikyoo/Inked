import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../../styles/tokens.css';
import '../../styles/base.css';

// Placeholder; the visitor board replaces this. Deliberately imports no store or crypto code.
createRoot(document.getElementById('openboard-root')!).render(
  <StrictMode>
    <div>Openboard</div>
  </StrictMode>,
);
