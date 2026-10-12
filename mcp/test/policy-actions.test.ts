import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, isAction, loadConfig, parseConfig } from '../src/policy';

describe('policy actions added for in-client setup', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'inked-policy-'));
    process.env.INKED_MCP_HOME = home;
  });

  it('knows @manage and config.change', () => {
    const c = parseConfig({ version: 1, vaults: '*', actions: ['@manage', 'config.change'] });
    expect([...c.actions].sort()).toEqual(['config.change', 'vault.create']);
    expect(isAction('vault.create')).toBe(true);
    expect(isAction('vault.delete')).toBe(false);
  });

  it('defaults to read plus config.change when there is no config file', () => {
    expect(DEFAULT_CONFIG).toEqual({ version: 1, vaults: '*', actions: ['@read', 'config.change'] });
    expect([...loadConfig().actions].sort()).toEqual(['config.change', 'note.read', 'search', 'tree.read', 'vault.list']);
  });

  it('still accepts a 0.1.0 config, which then lacks config.change', () => {
    const c = parseConfig({ version: 1, vaults: ['Work'], actions: ['@read', '@write'] });
    expect(c.actions.has('config.change')).toBe(false);
  });

  it('does not put the default config path in a JSON error', () => {
    writeFileSync(path.join(home, 'config.json'), '{oops');
    expect(() => loadConfig()).toThrow('Config file is not valid JSON');
    try {
      loadConfig();
    } catch (e) {
      expect((e as Error).message).not.toContain(home);
    }
  });
});
