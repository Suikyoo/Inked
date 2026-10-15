import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { configPath } from './home';
import { ACTIONS, ConfigError, GROUPS, parseConfig, type Action, type Policy } from './policy';

/** The config file as it is stored. */
export interface ConfigFile {
  version: 1;
  vaults: '*' | string[];
  actions: string[];
  limits?: { writesPerMinute?: number };
  imageDirs?: string[];
}

/** Access settings with vaults resolved to ids: what the settings page shows and edits. */
export interface ConfigView {
  allVaults: boolean;
  vaultIds: Set<string>;
  actions: Set<Action>;
  writesPerMinute: number;
  imageDirs: string[];
}

export interface NamedVault {
  id: string;
  name: string;
}

export function viewOf(policy: Policy): ConfigView {
  return {
    allVaults: policy.allVaults,
    vaultIds: new Set(policy.vaultIds),
    actions: new Set(policy.actions),
    writesPerMinute: policy.writesPerMinute,
    imageDirs: [...policy.imageDirs],
  };
}

/** A vault's name when no other vault shares it, else its id: readable, never ambiguous. */
export function vaultRef(id: string, vaults: NamedVault[]): string {
  const v = vaults.find((x) => x.id === id);
  return v && vaults.filter((x) => x.name === v.name).length === 1 ? v.name : id;
}

/** Whole groups by name, then the remaining single actions, both in a fixed order. */
export function compressActions(actions: ReadonlySet<Action>): string[] {
  const out: string[] = [];
  const covered = new Set<Action>();
  for (const [group, members] of Object.entries(GROUPS)) {
    if (members.every((a) => actions.has(a))) {
      out.push(group);
      members.forEach((a) => covered.add(a));
    }
  }
  for (const a of ACTIONS) if (actions.has(a) && !covered.has(a)) out.push(a);
  return out;
}

export function toConfigFile(view: ConfigView, vaults: NamedVault[]): ConfigFile {
  return {
    version: 1,
    vaults: view.allVaults ? '*' : vaults.filter((v) => view.vaultIds.has(v.id)).map((v) => vaultRef(v.id, vaults)),
    actions: compressActions(view.actions),
    limits: { writesPerMinute: view.writesPerMinute },
    ...(view.imageDirs.length ? { imageDirs: view.imageDirs } : {}),
  };
}

/** The config file, or null when there is none. Throws ConfigError when it is invalid. */
export function readConfigFile(file = configPath()): ConfigFile | null {
  if (!existsSync(file)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new ConfigError('Config file is not valid JSON');
  }
  parseConfig(raw);
  return raw as ConfigFile;
}

/** Writes through a temp file and a rename, so a reader never sees half a file. */
export function writeConfigFile(cfg: ConfigFile, file = configPath()): void {
  parseConfig(cfg); // never write a file the server would refuse
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n');
    renameSync(tmp, file);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      // nothing to remove
    }
    throw e;
  }
}
