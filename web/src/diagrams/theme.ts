import type { DiagramTheme } from './protocol';

function cssVar(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

/**
 * Inked's colors for Mermaid, read from the CSS variables. Mermaid does colour maths on these, so they must be
 * literal colors, not var(). The app is dark-only; if a light theme is added, the cache key must include the theme.
 */
export function readDiagramTheme(): DiagramTheme {
  return {
    darkMode: true,
    background: cssVar('--panel', '#1b1a21'),
    fontFamily: cssVar('--font-ui', "'Public Sans', system-ui, -apple-system, 'Segoe UI', sans-serif"),
    fontSize: '14px',
    textColor: cssVar('--text', '#e6e3ee'),
    primaryColor: cssVar('--panel-3', '#24222c'),
    primaryTextColor: cssVar('--text', '#e6e3ee'),
    primaryBorderColor: cssVar('--ink', '#7452e0'),
    secondaryColor: cssVar('--panel-2', '#211f28'),
    tertiaryColor: cssVar('--side', '#121117'),
    lineColor: cssVar('--ink-link', '#8d7bc4'),
    noteBkgColor: cssVar('--panel-2', '#211f28'),
    noteTextColor: cssVar('--text', '#e6e3ee'),
    noteBorderColor: cssVar('--border-2', '#34323f'),
  };
}
