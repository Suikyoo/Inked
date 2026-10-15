// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { createRenderer } from './renderer';

const THEME = { darkMode: true, primaryColor: '#24222c' };

function make(overrides: { render?: ReturnType<typeof vi.fn>; initialize?: ReturnType<typeof vi.fn> } = {}) {
  const calls: string[] = [];
  const initialize = overrides.initialize ?? vi.fn(() => void calls.push('initialize'));
  const render = overrides.render ?? vi.fn(async (id: string) => ({ svg: `<svg id="${id}"></svg>` }));
  const mermaid = { initialize, render } as never; // only these two members are used
  const loadMermaid = vi.fn(async () => mermaid);
  const loadFonts = vi.fn(async () => void calls.push('fonts'));
  const renderer = createRenderer({ theme: THEME, loadMermaid, loadFonts });
  return { renderer, initialize, render, loadMermaid, loadFonts, calls };
}

describe('createRenderer', () => {
  it('renders and returns the svg under the same id', async () => {
    const { renderer, render } = make();
    const r = await renderer.render('inked-dg-1', ' graph TD; A-->B \n');
    expect(r).toEqual({ type: 'result', id: 'inked-dg-1', ok: true, svg: '<svg id="inked-dg-1"></svg>', css: '' });
    expect(render).toHaveBeenCalledWith('inked-dg-1', 'graph TD; A-->B');
  });

  it('lifts styles out of the svg Mermaid returns', async () => {
    const render = vi.fn(async () => ({
      svg: '<svg id="x" style="opacity:0.5"><style>#x .n{fill:red}</style><rect class="n"/></svg>',
    }));
    const { renderer } = make({ render });
    const r = await renderer.render('x', 'graph TD; A-->B');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.svg).not.toContain('<style');
    expect(r.svg).not.toContain(' style=');
    expect(r.svg).toContain('data-inline-style="opacity:0.5"');
    expect(r.css).toContain('#x .n{fill:red}');
  });

  it('reports syntax when the output holds no svg', async () => {
    const render = vi.fn(async () => ({ svg: '<div>not an svg</div>' }));
    const { renderer } = make({ render });
    expect(await renderer.render('a', 'graph TD; A-->B')).toEqual({ type: 'result', id: 'a', ok: false, reason: 'syntax' });
  });

  it('loads fonts before Mermaid is configured, and configures once', async () => {
    const { renderer, initialize, loadMermaid, calls } = make();
    await renderer.render('a', 'graph TD; A-->B');
    await renderer.render('b', 'graph TD; B-->C');
    expect(calls).toEqual(['fonts', 'initialize']);
    expect(initialize).toHaveBeenCalledTimes(1);
    expect(loadMermaid).toHaveBeenCalledTimes(1);
  });

  it('configures Mermaid strict, with our limits, the sent theme and a locked secure list', async () => {
    const { renderer, initialize } = make();
    await renderer.render('a', 'graph TD; A-->B');
    const cfg = initialize.mock.calls[0][0];
    expect(cfg).toMatchObject({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'base',
      themeVariables: THEME,
      htmlLabels: false,
      maxTextSize: 20000,
      maxEdges: 200,
      flowchart: { htmlLabels: false },
    });
    // A note's %%{init}%% directive may not change the theme or inject css.
    expect(cfg.secure).toEqual(
      expect.arrayContaining(['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'maxEdges', 'theme', 'themeCSS', 'themeVariables', 'fontFamily']),
    );
    expect(typeof cfg.themeCSS).toBe('string');
  });

  it('keeps diagrams at their natural size (no shrink-to-fit) for every diagram type', async () => {
    const { renderer, initialize } = make();
    await renderer.render('a', 'graph TD; A-->B');
    const cfg = initialize.mock.calls[0][0];
    for (const key of ['flowchart', 'sequence', 'class', 'state', 'er', 'gantt', 'journey', 'pie', 'requirement', 'gitGraph', 'mindmap', 'timeline']) {
      expect(cfg[key], key).toMatchObject({ useMaxWidth: false });
    }
    expect(cfg.flowchart.htmlLabels).toBe(false);
  });

  it('refuses an oversized source without loading anything', async () => {
    const { renderer, loadMermaid, render } = make();
    const r = await renderer.render('a', `graph TD;\n${'A-->B;\n'.repeat(5000)}`);
    expect(r).toEqual({ type: 'result', id: 'a', ok: false, reason: 'oversized' });
    expect(loadMermaid).not.toHaveBeenCalled();
    expect(render).not.toHaveBeenCalled();
  });

  it('maps a parse error to syntax with the first line only', async () => {
    const render = vi.fn().mockRejectedValue(new Error('Parse error on line 2:\n...A--\n-----^\nExpecting X'));
    const { renderer } = make({ render });
    const r = await renderer.render('a', 'graph TD\nA--');
    expect(r).toEqual({ type: 'result', id: 'a', ok: false, reason: 'syntax', message: 'Parse error on line 2:' });
  });

  it('maps an edge-limit error to oversized', async () => {
    const render = vi.fn().mockRejectedValue(new Error('Edge limit exceeded. 201 edges found, but the limit is 200.'));
    const { renderer } = make({ render });
    const r = await renderer.render('a', 'graph TD; A-->B');
    expect(r).toMatchObject({ ok: false, reason: 'oversized' });
  });

  it('reports a load failure and retries on the next render', async () => {
    const initialize = vi.fn();
    initialize.mockImplementationOnce(() => {
      throw new Error('chunk failed');
    });
    const { renderer } = make({ initialize });
    expect(await renderer.render('a', 'graph TD; A-->B')).toEqual({ type: 'result', id: 'a', ok: false, reason: 'load' });
    const again = await renderer.render('b', 'graph TD; A-->B');
    expect(again.ok).toBe(true);
  });

  it('removes the temporary node Mermaid leaves behind on an error', async () => {
    const render = vi.fn(async (id: string) => {
      const leftover = document.createElement('div');
      leftover.id = `d${id}`;
      document.body.append(leftover);
      throw new Error('boom');
    });
    const { renderer } = make({ render });
    await renderer.render('inked-dg-7', 'graph TD; A-->B');
    expect(document.getElementById('dinked-dg-7')).toBeNull();
  });
});
