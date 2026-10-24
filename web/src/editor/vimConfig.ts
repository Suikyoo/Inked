/**
 * Compiles the owner's vim config — a small, fixed subset of Lua — into keymaps and options.
 *
 * The text is *parsed, never executed*: there is no Lua interpreter here and no `eval`. Only two statement
 * forms are understood, `vim.keymap.set(...)` and `vim.o.<option> = <literal>`; everything else is reported
 * with its line number. A config with any error compiles to nothing at all, so a typo cannot leave half the
 * owner's keymaps applied (see the design's ruling 7).
 */

export type VimMode = 'n' | 'i' | 'v';

export interface VimKeymap {
  modes: VimMode[];
  lhs: string;
  rhs: string;
  /** False means the mapping does not itself expand other mappings (`vim.keymap.set`'s default). */
  remap: boolean;
}

/**
 * The options the config may set. Deliberately only what the editor can actually honour: `@replit/codemirror-vim`
 * defines just `filetype`, `textwidth`, `langmap`, `pcre` and `insertModeEscKeysTimeout`, so `ignorecase`,
 * `smartcase` and `scrolloff` are rejected rather than accepted and quietly ignored.
 */
export interface VimOptions {
  number?: boolean;
  relativenumber?: boolean;
  wrap?: boolean;
  tabstop?: number;
  expandtab?: boolean;
}

/**
 * The `vim.g` globals the config may set. Only the two leaders: the engine has no notion of globals, so any
 * other name would be accepted and then quietly ignored — the failure the option allowlist exists to prevent.
 */
export interface VimGlobals {
  mapleader?: string;
  maplocalleader?: string;
}

export interface VimConfigError {
  /** 1-based line in the config text. */
  line: number;
  message: string;
}

export interface VimConfig {
  keymaps: VimKeymap[];
  options: VimOptions;
  globals: VimGlobals;
  errors: VimConfigError[];
}

const MODES: Record<string, VimMode> = { n: 'n', i: 'i', v: 'v' };

/** The longest config accepted, in characters. Past this it is refused unparsed. */
export const VIM_CONFIG_MAX = 64_000;

/** Every option the config may set, and the type its value must have. Anything else is an error. */
const OPTIONS: Record<keyof VimOptions, 'boolean' | 'number'> = {
  number: 'boolean',
  relativenumber: 'boolean',
  wrap: 'boolean',
  tabstop: 'number',
  expandtab: 'boolean',
};
const OPTION_NAMES = Object.keys(OPTIONS).join(', ');

const GLOBALS = ['mapleader', 'maplocalleader'] as const;
const GLOBAL_NAMES = GLOBALS.join(', ');

/** Vim's own default leader, used until `vim.g.mapleader` says otherwise. */
const DEFAULT_LEADER = '\\';

/**
 * One character of a leader in the engine's key notation.
 *
 * A leader is substituted into a mapping's keys, which the engine then tokenises — so a literal space has to
 * become `<Space>` and a literal `<` has to become `<lt>`, or the engine reads them as syntax. Both spellings
 * are the engine's own (see `<Space>` in its default keymap, and its `lt` key name).
 */
const KEY_NOTATION: Record<string, string> = { ' ': '<Space>', '<': '<lt>', '\t': '<Tab>' };
const asKeys = (leader: string) => [...leader].map((c) => KEY_NOTATION[c] ?? c).join('');

/** `<leader>` and `<localleader>`, in any case, as real configs spell them (`<Leader>` is the common one). */
const LEADER_RE = /<leader>/gi;
const LOCALLEADER_RE = /<localleader>/gi;
const usesLeader = (text: string) => LEADER_RE.test(text);
const usesLocalLeader = (text: string) => LOCALLEADER_RE.test(text);

/** Substitutes the leaders in force into a mapping's keys, the way vim expands them at definition time. */
function expandLeaders(text: string, globals: VimGlobals): string {
  return text
    .replace(LOCALLEADER_RE, asKeys(globals.maplocalleader ?? DEFAULT_LEADER))
    .replace(LEADER_RE, asKeys(globals.mapleader ?? DEFAULT_LEADER));
}

// ---- Tokens -----------------------------------------------------------------------------------------------

type TokenKind = 'name' | 'str' | 'num' | 'bool' | 'punct' | 'bad';
interface Token {
  kind: TokenKind;
  value: string;
  line: number;
}

const NAME_START = /[A-Za-z_]/;
const NAME_PART = /[A-Za-z0-9_]/;
const DIGIT = /[0-9]/;
const PUNCT = '(){},=.';

const ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"' };

/**
 * The whole config as a token list. Comments vanish; an unreadable character becomes a `bad` token so the
 * parser can report the line rather than throw.
 */
function tokenize(text: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  let line = 1;
  while (i < text.length) {
    const c = text[i];
    if (c === '\n') {
      line++;
      i++;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      i++;
      continue;
    }
    if (c === '-' && text[i + 1] === '-') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (c === "'" || c === '"') {
      const quote = c;
      const startLine = line;
      let value = '';
      i++;
      let closed = false;
      while (i < text.length) {
        const ch = text[i];
        if (ch === '\\') {
          const next = text[i + 1] ?? '';
          value += ESCAPES[next] ?? next;
          i += 2;
          continue;
        }
        if (ch === quote) {
          i++;
          closed = true;
          break;
        }
        if (ch === '\n') break;
        value += ch;
        i++;
      }
      out.push(closed ? { kind: 'str', value, line: startLine } : { kind: 'bad', value: quote, line: startLine });
      continue;
    }
    if (DIGIT.test(c) || (c === '-' && DIGIT.test(text[i + 1] ?? ''))) {
      let value = text[i++];
      while (i < text.length && (DIGIT.test(text[i]) || text[i] === '.')) value += text[i++];
      out.push({ kind: 'num', value, line });
      continue;
    }
    if (NAME_START.test(c)) {
      let value = '';
      while (i < text.length && NAME_PART.test(text[i])) value += text[i++];
      out.push({ kind: value === 'true' || value === 'false' ? 'bool' : 'name', value, line });
      continue;
    }
    if (PUNCT.includes(c)) {
      out.push({ kind: 'punct', value: c, line });
      i++;
      continue;
    }
    out.push({ kind: 'bad', value: c, line });
    i++;
  }
  return out;
}

// ---- Parsing ----------------------------------------------------------------------------------------------

/** Thrown inside the parser, caught per statement, turned into a `VimConfigError`. */
class Bad extends Error {
  constructor(
    readonly line: number,
    message: string,
  ) {
    super(message);
  }
}

const ONLY = 'this config defines keymaps and options only';
const UNREADABLE = 'cannot read this line; the config understands vim.keymap.set(...) and vim.o.<option> = ... only';

class Parser {
  private at = 0;
  constructor(private readonly tokens: Token[]) {}

  get done(): boolean {
    return this.at >= this.tokens.length;
  }

  peek(ahead = 0): Token | undefined {
    return this.tokens[this.at + ahead];
  }

  /** The line a statement starting here belongs to; used for both the error and the resync. */
  get line(): number {
    return this.peek()?.line ?? 0;
  }

  next(): Token {
    const t = this.peek();
    if (!t) throw new Bad(this.tokens[this.tokens.length - 1]?.line ?? 1, UNREADABLE);
    this.at++;
    return t;
  }

  /** Consumes a token of this kind and value, or fails the statement. */
  eat(kind: TokenKind, value?: string): Token {
    const t = this.peek();
    if (!t || t.kind !== kind || (value !== undefined && t.value !== value)) {
      throw new Bad(t?.line ?? this.line, UNREADABLE);
    }
    this.at++;
    return t;
  }

  is(kind: TokenKind, value?: string): boolean {
    const t = this.peek();
    return !!t && t.kind === kind && (value === undefined || t.value === value);
  }

  /**
   * After a failed statement, moves to the next token that can start one on a later line, so one bad
   * statement yields exactly one error.
   */
  resync(errorLine: number): void {
    while (!this.done) {
      const t = this.peek()!;
      if (t.line > errorLine && t.kind === 'name') return;
      this.at++;
    }
  }
}

/** A Lua string literal. A `function` here is the one rejection worth naming on sight. */
function parseString(p: Parser): string {
  if (p.is('name', 'function')) throw new Bad(p.line, 'a function right-hand side needs real Lua; use a key sequence string');
  return p.eat('str').value;
}

/** `{'n', 'v'}` — a brace list of strings. */
function parseStringList(p: Parser): string[] {
  p.eat('punct', '{');
  const out: string[] = [];
  while (!p.is('punct', '}')) {
    out.push(parseString(p));
    if (p.is('punct', ',')) p.next();
  }
  p.eat('punct', '}');
  return out;
}

/** `{ desc = "x", remap = true }` — a brace table of `name = literal`. Unknown keys are kept, not refused. */
function parseOptsTable(p: Parser): Record<string, string | number | boolean> {
  p.eat('punct', '{');
  const out: Record<string, string | number | boolean> = {};
  while (!p.is('punct', '}')) {
    const key = p.eat('name').value;
    p.eat('punct', '=');
    out[key] = parseLiteral(p);
    if (p.is('punct', ',')) p.next();
  }
  p.eat('punct', '}');
  return out;
}

function parseLiteral(p: Parser): string | number | boolean {
  if (p.is('str')) return p.eat('str').value;
  if (p.is('bool')) return p.eat('bool').value === 'true';
  if (p.is('num')) return Number(p.eat('num').value);
  if (p.is('name', 'function')) throw new Bad(p.line, 'a function right-hand side needs real Lua; use a key sequence string');
  throw new Bad(p.line, UNREADABLE);
}

/** `vim.o.<name> = <literal>` / `vim.opt.<name> = <literal>`, checked against the allowlist. */
function parseOption(p: Parser, line: number): [keyof VimOptions, boolean | number] {
  p.eat('punct', '.');
  const name = p.eat('name').value;
  p.eat('punct', '=');
  const value = parseLiteral(p);
  const want = OPTIONS[name as keyof VimOptions];
  if (!want) throw new Bad(line, `unknown option \`${name}\`; supported: ${OPTION_NAMES}`);
  if (want === 'number' && typeof value !== 'number') throw new Bad(line, `\`${name}\` takes a number`);
  if (want === 'boolean' && typeof value !== 'boolean') throw new Bad(line, `\`${name}\` takes true or false`);
  return [name as keyof VimOptions, value as boolean | number];
}

/** `vim.g.<name> = <literal>`, allowlisted to the two leaders. */
function parseGlobal(p: Parser, line: number): [keyof VimGlobals, string] {
  p.eat('punct', '.');
  const name = p.eat('name').value;
  p.eat('punct', '=');
  const value = parseLiteral(p);
  if (!GLOBALS.includes(name as (typeof GLOBALS)[number])) {
    throw new Bad(line, `unknown global \`${name}\`; supported: ${GLOBAL_NAMES}`);
  }
  if (typeof value !== 'string') throw new Bad(line, `\`${name}\` takes a string, such as ' ' or ','`);
  if (value === '') throw new Bad(line, `\`${name}\` cannot be empty`);
  return [name as keyof VimGlobals, value];
}

/** The statement heads worth a message of their own, rather than "cannot read this line". */
const NAMED_REJECTIONS: Record<string, string> = {
  require: `\`require\` is not supported; ${ONLY}`,
  if: `control flow is not supported; ${ONLY}`,
  for: `control flow is not supported; ${ONLY}`,
  while: `control flow is not supported; ${ONLY}`,
  repeat: `control flow is not supported; ${ONLY}`,
  function: `defining functions is not supported; ${ONLY}`,
  local: `local variables are not supported; ${ONLY}`,
};

interface ParsedKeymap extends VimKeymap {
  /** Which leaders this mapping spelled, so setting that same one later can be refused as too late. */
  used: { mapleader: boolean; maplocalleader: boolean };
}

function parseKeymapSet(p: Parser, line: number, globals: VimGlobals): ParsedKeymap {
  p.eat('punct', '(');
  const rawModes = p.is('punct', '{') ? parseStringList(p) : [parseString(p)];
  p.eat('punct', ',');
  const rawLhs = parseString(p);
  p.eat('punct', ',');
  const rawRhs = parseString(p);
  let opts: Record<string, string | number | boolean> = {};
  if (p.is('punct', ',')) {
    p.next();
    if (p.is('punct', '{')) opts = parseOptsTable(p);
  }
  p.eat('punct', ')');

  const modes: VimMode[] = [];
  for (const m of rawModes) {
    const mode = MODES[m];
    if (!mode) throw new Bad(line, `unknown mode \`${m}\`; use 'n', 'i' or 'v'`);
    if (!modes.includes(mode)) modes.push(mode);
  }
  if (modes.length === 0) throw new Bad(line, 'no mode given; use \'n\', \'i\' or \'v\'');
  if (rawLhs === '') throw new Bad(line, 'the key to map cannot be empty');

  // `vim.keymap.set` does not remap by default; `remap = true` opts in, and an explicit `noremap` wins.
  const remap = opts.noremap === true ? false : opts.remap === true;
  return {
    modes,
    lhs: expandLeaders(rawLhs, globals),
    rhs: expandLeaders(rawRhs, globals),
    remap,
    used: {
      mapleader: usesLeader(rawLhs) || usesLeader(rawRhs),
      maplocalleader: usesLocalLeader(rawLhs) || usesLocalLeader(rawRhs),
    },
  };
}

export function compileVimConfig(text: string): VimConfig {
  const keymaps: ParsedKeymap[] = [];
  const options: VimOptions = {};
  const globals: VimGlobals = {};
  const errors: VimConfigError[] = [];
  /** Where each leader was first spelled, so setting that one later can say what it is too late for. */
  const usedAt: Record<keyof VimGlobals, number | null> = { mapleader: null, maplocalleader: null };
  if (text.length > VIM_CONFIG_MAX) {
    return {
      keymaps: [],
      options: {},
      globals: {},
      errors: [{ line: 1, message: `this config is too long (over ${VIM_CONFIG_MAX} characters)` }],
    };
  }
  const p = new Parser(tokenize(text));

  while (!p.done) {
    const line = p.line;
    try {
      const head = p.peek();
      if (head?.kind === 'name' && NAMED_REJECTIONS[head.value]) throw new Bad(line, NAMED_REJECTIONS[head.value]);
      p.eat('name', 'vim');
      p.eat('punct', '.');
      const which = p.eat('name').value;
      if (which === 'keymap') {
        p.eat('punct', '.');
        p.eat('name', 'set');
        const keymap = parseKeymapSet(p, line, globals);
        for (const g of GLOBALS) if (keymap.used[g] && usedAt[g] === null) usedAt[g] = line;
        keymaps.push(keymap);
      } else if (which === 'g') {
        const [name, value] = parseGlobal(p, line);
        // Vim expands a leader where the mapping is written, so a leader set afterwards never reaches it.
        const already = usedAt[name];
        if (already !== null) {
          throw new Bad(
            line,
            `\`${name}\` is set too late: the mapping on line ${already} already used it, so it took the previous leader. Move this line above it.`,
          );
        }
        globals[name] = value;
      } else if (which === 'o' || which === 'opt') {
        const [name, value] = parseOption(p, line);
        (options as Record<string, boolean | number>)[name] = value;
      } else {
        throw new Bad(line, UNREADABLE);
      }
    } catch (e) {
      const bad = e instanceof Bad ? e : new Bad(line, UNREADABLE);
      errors.push({ line: bad.line, message: bad.message });
      p.resync(bad.line);
    }
  }

  // One bad line costs every keymap: half-applied config would leave the owner guessing which half.
  if (errors.length > 0) return { keymaps: [], options: {}, globals: {}, errors };
  return { keymaps: keymaps.map(({ used: _drop, ...k }) => k), options, globals, errors };
}
