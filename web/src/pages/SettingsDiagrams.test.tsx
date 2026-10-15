// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const clearDiagrams = vi.fn();
vi.mock('../diagrams/diagramRender', () => ({ clearDiagrams: () => clearDiagrams() }));

const { DiagramSettings } = await import('./SettingsDiagrams');

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = host = null;
  localStorage.clear();
  clearDiagrams.mockReset();
});

async function mount() {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(<DiagramSettings />));
  return host;
}
const box = (el: HTMLElement) => el.querySelector('input[type="checkbox"]') as HTMLInputElement;

describe('DiagramSettings', () => {
  it('shows the preference, on by default, under a labelled heading', async () => {
    const el = await mount();
    expect(box(el).checked).toBe(true);
    expect(el.querySelector('#diagrams-h')!.textContent).toBe('Diagrams');
    expect(el.textContent).toContain('Draw Mermaid diagrams in notes');
    expect(el.textContent).toContain('this browser only');
  });

  it('turning it off stores the choice and removes any existing renderer', async () => {
    const el = await mount();
    await act(async () => box(el).click());
    expect(box(el).checked).toBe(false);
    expect(localStorage.getItem('inked.diagrams')).toBe('off');
    expect(clearDiagrams).toHaveBeenCalledTimes(1);
  });

  it('turning it back on stores the choice without touching the renderer', async () => {
    localStorage.setItem('inked.diagrams', 'off');
    const el = await mount();
    expect(box(el).checked).toBe(false);
    await act(async () => box(el).click());
    expect(box(el).checked).toBe(true);
    expect(localStorage.getItem('inked.diagrams')).toBeNull();
    expect(clearDiagrams).not.toHaveBeenCalled();
  });
});
