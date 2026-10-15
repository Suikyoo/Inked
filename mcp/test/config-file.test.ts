import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { compressActions, readConfigFile, toConfigFile, viewOf, writeConfigFile, type ConfigView } from '../src/config-file';
import { ConfigError, parseConfig, resolvePolicy, type Action } from '../src/policy';

const V = [
  { id: 'a', name: 'Work' },
  { id: 'b', name: 'Ideas' },
  { id: 'c', name: 'Ideas' },
];

describe('config file', () => {
  it('compresses whole groups and keeps single actions in a fixed order', () => {
    const actions = new Set<Action>(['config.change', 'note.create', 'search', 'note.read', 'tree.read', 'vault.list']);
    expect(compressActions(actions)).toEqual(['@read', 'note.create', 'config.change']);
  });

  it('writes vault names, and ids for names that repeat', () => {
    const view: ConfigView = { allVaults: false, vaultIds: new Set(['a', 'c']), actions: new Set(['vault.list']), writesPerMinute: 120, imageDirs: [] };
    expect(toConfigFile(view, V)).toEqual({ version: 1, vaults: ['Work', 'c'], actions: ['vault.list'], limits: { writesPerMinute: 120 } });
  });

  it('writes "*" for all vaults', () => {
    const view: ConfigView = { allVaults: true, vaultIds: new Set(), actions: new Set(['vault.list']), writesPerMinute: 30, imageDirs: [] };
    expect(toConfigFile(view, V).vaults).toBe('*');
  });

  it('round-trips a view through the file format', () => {
    const view: ConfigView = {
      allVaults: false,
      vaultIds: new Set(['a', 'b']),
      actions: new Set<Action>(['vault.list', 'tree.read', 'note.read', 'search', 'vault.create']),
      writesPerMinute: 60,
      imageDirs: [],
    };
    expect(viewOf(resolvePolicy(parseConfig(toConfigFile(view, V)), V))).toEqual(view);
  });

  it('reads null when missing, writes atomically, and throws ConfigError on a bad file', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'inked-cfgfile-'));
    const file = path.join(dir, 'config.json');
    expect(readConfigFile(file)).toBeNull();
    writeConfigFile({ version: 1, vaults: '*', actions: ['@read'] }, file);
    expect(readConfigFile(file)).toEqual({ version: 1, vaults: '*', actions: ['@read'] });
    expect(readdirSync(dir)).toEqual(['config.json']);
    writeFileSync(file, '{oops');
    expect(() => readConfigFile(file)).toThrow(ConfigError);
  });

  it('removes its temp file when the write fails', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'inked-cfgfile-'));
    const file = path.join(dir, 'config.json');
    mkdirSync(file); // a folder in its place: the rename fails
    expect(() => writeConfigFile({ version: 1, vaults: '*', actions: ['@read'] }, file)).toThrow();
    expect(readdirSync(dir)).toEqual(['config.json']);
  });

  it('refuses to write a config the server would reject', () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'inked-cfgfile-')), 'config.json');
    expect(() => writeConfigFile({ version: 1, vaults: [], actions: ['@read'] }, file)).toThrow(ConfigError);
  });
});

describe('imageDirs in the config file', () => {
  const dir = path.resolve('image-test-dir');
  it('survives a view round trip and is omitted when empty', () => {
    const policy = resolvePolicy(parseConfig({ version: 1, vaults: '*', actions: ['image.create'], imageDirs: [dir] }), []);
    const view = viewOf(policy);
    expect(view.imageDirs).toEqual([dir]);
    expect(toConfigFile(view, []).imageDirs).toEqual([dir]);
    const none = viewOf(resolvePolicy(parseConfig({ version: 1, vaults: '*', actions: ['@read'] }), []));
    expect('imageDirs' in toConfigFile(none, [])).toBe(false);
  });
  it('lists image.create as its own action when compressing', () => {
    expect(compressActions(new Set(['note.read', 'image.create'] as const))).toEqual(['note.read', 'image.create']);
  });
});
