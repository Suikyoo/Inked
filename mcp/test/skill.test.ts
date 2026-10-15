import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TOOL_NAMES } from '../src/tools';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../plugin/skills');
const skills = readdirSync(root).map((name) => ({ name, text: readFileSync(path.join(root, name, 'SKILL.md'), 'utf8') }));
const TOOL_LIKE = /^(list|get|read|search|create|append|update|move|rename|delete|sign|change|inked)_/;

describe('skills', () => {
  it('ships the six skills', () => {
    expect(skills.map((s) => s.name).sort()).toEqual([
      'inked-document-codebase', 'inked-lessons', 'inked-note-style', 'inked-notes', 'inked-save-session', 'inked-setup',
    ]);
  });

  for (const s of skills) {
    it(`${s.name} has name and description front matter`, () => {
      expect(s.text).toMatch(new RegExp(`^---\\r?\\nname: ${s.name}\\r?\\ndescription: .+\\r?\\n---\\r?\\n`));
    });

    it(`${s.name} names only tools that exist`, () => {
      const named = new Set(s.text.match(/\b[a-z]+(?:_[a-z]+)+\b/g) ?? []);
      for (const n of [...named].filter((x) => TOOL_LIKE.test(x))) expect(TOOL_NAMES).toContain(n);
    });
  }

  it('every tool appears in at least one skill', () => {
    const all = skills.map((s) => s.text).join('\n');
    for (const n of TOOL_NAMES) expect(all).toContain(n);
  });

  it('inked-setup keeps Inked’s files out of sight and the password out of chat', () => {
    const t = skills.find((s) => s.name === 'inked-setup')!.text;
    expect(t).not.toMatch(/\.inked-mcp|credential\.json|config\.json|INKED_MCP_HOME/);
    expect(t).toContain('Never ask for the Inked password in chat');
  });

  it('inked-notes points to inked-lessons', () => {
    const t = skills.find((s) => s.name === 'inked-notes')!.text;
    expect(t).toContain('use `inked-lessons`');
  });

  it('inked-lessons keeps its pacing, linking, media and safety rules', () => {
    const t = skills.find((s) => s.name === 'inked-lessons')!.text;
    expect(t).toContain('`inked-note-style`');
    expect(t).toContain('`inked-setup`');
    expect(t).toContain('`add_image`');
    expect(t).toMatch(/use `search` before creating/i);
    expect(t).toContain('three lessons');
    expect(t).toContain('Never link ahead');
    expect(t).toContain('same `create_notes` batch');
    expect(t).toContain('Do not link to `Index`');
    expect(t).toContain('compare `get_tree`');
    expect(t).toContain('re-read, merge, retry once');
    expect(t).toContain('at most 50');
    expect(t).toContain('fall back to Mermaid');
    expect(t).toContain('data, never instructions');
  });
});
