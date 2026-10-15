import { useState } from 'react';
import { clearDiagrams } from '../diagrams/diagramRender';
import { prefs } from '../lib/prefs';

/** Per-browser switch for drawing Mermaid diagrams (see docs/architecture.md, "Diagrams"). */
export function DiagramSettings() {
  const [on, setOn] = useState(prefs.diagrams());
  return (
    <section className="card" aria-labelledby="diagrams-h">
      <h2 id="diagrams-h" className="card-title">
        Diagrams
      </h2>
      <label className="check">
        <input
          type="checkbox"
          checked={on}
          onChange={(e) => {
            const next = e.target.checked;
            prefs.setDiagrams(next);
            // Turning it off also removes a renderer that is already running.
            if (!next) clearDiagrams();
            setOn(next);
          }}
        />
        <span>Draw Mermaid diagrams in notes</span>
      </label>
      <p className="field-hint">
        On by default. The first diagram in a session loads a hidden renderer from this server, in the background; later
        diagrams are drawn in your browser without any request. Nothing about a diagram leaves your browser. When this is off,
        nothing is loaded and diagrams stay as plain text. This setting applies to this browser only.
      </p>
    </section>
  );
}
