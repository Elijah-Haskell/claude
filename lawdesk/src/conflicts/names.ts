// Name normalisation and fuzzy name matching for conflict checks.
//
// The goal is to err towards flagging: a lawyer can dismiss a false hit in seconds, but a
// missed conflict is costly. Every score comes with the rules that produced it so the
// person reviewing the check can see why a name came up.

export type NameKind = "person" | "company";

export interface Prepared {
  raw: string;
  /** Normalised tokens in reading order ("Smith, John Q." -> ["john", "q", "smith"]). */
  tokens: string[];
  /** Tokens joined with no spaces, for "Mc Donald" vs "McDonald". */
  joined: string;
  /** Tokens sorted, joined with spaces, for order-insensitive equality. */
  sortedKey: string;
  /** True when "Last, First" was turned round. */
  reordered: boolean;
  /** Suffixes and titles removed (llc, inc, jr, dr...). */
  stripped: string[];
  /** Per-token weights when scored as a person / as a company. */
  wPerson: number[];
  wCompany: number[];
}

// ------------------------------------------------------------ word lists

/** Company-form words removed from the end of a name. Multi-word forms are matched as token runs. */
const COMPANY_SUFFIXES = [
  "llc", "lc", "pllc", "llp", "lllp", "lp", "plc", "inc", "incorporated", "corp", "corporation", "co", "company",
  "ltd", "limited", "pa", "pc", "chartered", "chtd", "gmbh", "ag", "sa", "nv", "bv", "pty",
  "na", "fsb", "coop", "co op", "cooperative", "national association",
  "professional association", "professional corporation", "limited liability company", "limited liability partnership",
  "limited partnership", "and company", "and co",
];
/** Personal suffixes and post-nominals removed from the end of a name. */
const PERSON_SUFFIXES = ["jr", "sr", "ii", "iii", "iv", "esq", "esquire", "md", "phd", "dds", "do", "cpa", "jd", "dvm", "rn"];
/** Titles removed from the start of a name. */
const TITLES = new Set(["mr", "mrs", "ms", "miss", "mx", "dr", "hon", "judge", "rev", "fr", "sir", "dame", "prof", "atty"]);

const SUFFIX_SEQS: string[][] = [...COMPANY_SUFFIXES, ...PERSON_SUFFIXES].map((s) => s.split(" ")).sort((a, b) => b.length - a.length);
const SUFFIX_SINGLE = new Set([...COMPANY_SUFFIXES, ...PERSON_SUFFIXES].filter((s) => !s.includes(" ")));

/** Words so common in business names that sharing them says little. They count for less. */
const GENERIC = new Set([
  "and", "of", "for", "in", "at", "on", "a",
  "services", "service", "group", "holdings", "holding", "properties", "property", "enterprises", "enterprise",
  "construction", "consulting", "associates", "partners", "partnership", "solutions", "management", "investments",
  "investment", "development", "industries", "international", "national", "american", "america", "united",
  "kansas", "ks", "missouri", "mo", "wichita", "topeka", "olathe", "overland", "park", "lawrence", "city",
  "bank", "trust", "insurance", "law", "firm", "office", "offices", "farms", "farm", "realty", "real", "estate",
  "home", "homes", "builders", "auto", "motors", "sales", "supply", "systems", "technologies", "technology",
  "medical", "health", "healthcare", "clinic", "center", "family", "sons", "brothers", "bros", "capital", "financial",
  "ventures", "llc", "inc", "co", "foundation", "church", "school", "district", "county",
]);
/** The weight of a generic company word, and of the very weakest words. */
const W_GENERIC = 0.5;
const W_FILLER = 0.2;
const FILLER = new Set(["and", "of", "for", "in", "at", "on", "a"]);
/** Weight of a person's middle names and initials: a missing middle name is a weak difference. */
const W_MIDDLE = 0.25;

/** Common English given-name nicknames. A token may belong to several groups (al, chris, jerry...). */
const NICKNAME_GROUPS: string[][] = [
  ["william", "bill", "billy", "will", "willie", "willy", "liam"],
  ["robert", "bob", "bobby", "rob", "robbie", "bert"],
  ["richard", "rick", "ricky", "rich", "richie", "dick"],
  ["elizabeth", "liz", "lizzie", "beth", "betsy", "betty", "eliza", "libby", "liza", "elisabeth"],
  ["katherine", "catherine", "kathryn", "katharine", "kathrine", "kate", "katie", "kathy", "cathy", "kat", "kit", "kay", "katy"],
  ["kathleen", "kathy", "kate", "katie"],
  ["margaret", "maggie", "meg", "peggy", "marge", "margie", "greta", "maisie"],
  ["james", "jim", "jimmy", "jamie"],
  ["john", "jack", "johnny", "jon"],
  ["jonathan", "jon", "jonny"],
  ["joseph", "joe", "joey"],
  ["josephine", "jo", "josie"],
  ["thomas", "tom", "tommy"],
  ["michael", "mike", "mikey", "mick", "mickey"],
  ["charles", "charlie", "chuck", "chas", "chaz"],
  ["christopher", "chris", "kit", "topher"],
  ["christine", "christina", "chris", "tina", "chrissy", "kristin", "kristen", "kristine"],
  ["edward", "ed", "eddie", "ted", "ned"],
  ["theodore", "ted", "teddy", "theo"],
  ["anthony", "tony"],
  ["antonio", "tony"],
  ["daniel", "dan", "danny"],
  ["david", "dave", "davey"],
  ["steven", "stephen", "steve", "stevie"],
  ["alexander", "alex", "al", "sandy", "xander"],
  ["alexandra", "alex", "alexa", "lexi", "sandy", "sandra"],
  ["albert", "al", "bert"],
  ["alan", "allen", "allan", "al"],
  ["alfred", "al", "fred", "alf"],
  ["frederick", "fred", "freddy", "freddie", "fritz"],
  ["benjamin", "ben", "benny", "benji"],
  ["samuel", "sam", "sammy"],
  ["samantha", "sam", "sammy"],
  ["patricia", "pat", "patty", "patti", "trish", "tricia"],
  ["patrick", "pat", "paddy"],
  ["deborah", "debra", "deb", "debbie", "debby"],
  ["rebecca", "becky", "becca"],
  ["susan", "suzanne", "susanne", "sue", "susie", "suzy"],
  ["jennifer", "jen", "jenny", "jenn"],
  ["jessica", "jess", "jessie"],
  ["joshua", "josh"],
  ["matthew", "matt"],
  ["nicholas", "nick", "nicky"],
  ["andrew", "andy", "drew"],
  ["gregory", "greg"],
  ["jeffrey", "geoffrey", "jeff"],
  ["kenneth", "ken", "kenny"],
  ["lawrence", "laurence", "larry"],
  ["leonard", "len", "lenny", "leo"],
  ["gerald", "jerry", "gerry"],
  ["jerome", "jerry"],
  ["peter", "pete"],
  ["raymond", "ray"],
  ["ronald", "ron", "ronnie"],
  ["donald", "don", "donnie"],
  ["douglas", "doug"],
  ["timothy", "tim", "timmy"],
  ["zachary", "zach", "zack", "zak"],
  ["victoria", "vicky", "vicki", "tori"],
  ["virginia", "ginny", "ginger"],
  ["dorothy", "dot", "dottie", "dolly"],
  ["eleanor", "ellie", "nell", "nora"],
  ["helen", "nell", "nellie"],
  ["abigail", "abby", "abbie", "gail"],
  ["barbara", "barb", "babs", "barbie"],
  ["cynthia", "cindy"],
  ["judith", "judy"],
  ["kimberly", "kim"],
  ["pamela", "pam"],
  ["sandra", "sandy"],
  ["teresa", "theresa", "terry", "tess", "tessa"],
  ["terrence", "terence", "terry"],
  ["walter", "walt"],
  ["harold", "hal", "harry"],
  ["henry", "hank", "harry", "hal"],
  ["eugene", "gene"],
  ["francis", "frances", "frank", "fran", "frankie"],
  ["franklin", "frank"],
  ["nathan", "nathaniel", "nate", "nat"],
  ["philip", "phillip", "phil"],
  ["mary", "molly", "polly", "mae", "mamie"],
  ["sarah", "sara", "sally", "sadie"],
  ["ann", "anne", "anna", "annie", "nan", "nannie", "hannah"],
  ["vincent", "vince", "vinny"],
  ["gabriel", "gabe"],
  ["gabrielle", "gabby", "gabi"],
  ["madeline", "madeleine", "maddie", "maddy"],
  ["jacqueline", "jackie", "jacki"],
  ["louis", "lou", "louie"],
  ["louise", "lou", "lulu"],
  ["randall", "randolph", "randy"],
  ["stanley", "stan"],
  ["stuart", "stewart", "stu"],
  ["russell", "russ"],
  ["clifford", "cliff"],
  ["bradley", "brad"],
  ["frederica", "freddie"],
  ["valerie", "val"],
  ["cassandra", "cassie", "cass"],
  ["angela", "angie"],
  ["amanda", "mandy"],
  ["melissa", "missy", "mel"],
  ["melanie", "mel"],
  ["carolyn", "caroline", "carol", "carrie"],
  ["kristopher", "kris", "chris"],
  ["mitchell", "mitch"],
  ["montgomery", "monty"],
  ["johanna", "joanna", "jo"],
  ["bartholomew", "bart"],
  ["dwayne", "duane"],
  ["jacob", "jake"],
  ["isabel", "isabella", "izzy", "bella"],
];

const NICKNAMES = new Map<string, Set<number>>();
NICKNAME_GROUPS.forEach((g, i) => {
  for (const n of g) {
    if (!NICKNAMES.has(n)) NICKNAMES.set(n, new Set());
    NICKNAMES.get(n)!.add(i);
  }
});

export function areNicknames(a: string, b: string): boolean {
  const ga = NICKNAMES.get(a);
  const gb = NICKNAMES.get(b);
  if (!ga || !gb) return false;
  for (const g of ga) if (gb.has(g)) return true;
  return false;
}

// --------------------------------------------------------- normalisation

const ALSO_KNOWN_AS =
  /\s*(?:\b|\s)(?:d\s*\/\s*b\s*\/\s*a|dba|a\s*\/\s*k\s*\/\s*a|aka|f\s*\/\s*k\s*\/\s*a|fka|n\s*\/\s*k\s*\/\s*a|nka|t\s*\/\s*a|doing business as|also known as|formerly known as|now known as|trading as|formerly)\b\.?\s*/i;

/**
 * Split a name that carries other names in it ("John Smith d/b/a Smith Plumbing",
 * "Jane Doe f/k/a Jane Roe") into each name. Returns at least the original.
 */
export function splitNames(raw: string): string[] {
  const parts = String(raw ?? "")
    .split(new RegExp(ALSO_KNOWN_AS.source, "gi"))
    .map((s) => s.replace(/^[\s,;:()-]+|[\s,;:()-]+$/g, ""))
    .filter((s) => s.length > 0);
  return parts.length ? parts : [String(raw ?? "")];
}

const FOLD: Record<string, string> = { ß: "ss", æ: "ae", œ: "oe", ø: "o", ł: "l", đ: "d", ð: "d", þ: "th", ı: "i" };

/** Lower-case, strip accents, fold a few letters NFKD leaves alone, and spell out "&". */
export function fold(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[ßæœøłđðþı]/g, (c) => FOLD[c] ?? c)
    .replace(/[&+]/g, " and ")
    // L.L.C. -> llc, P.A. -> pa (dotted abbreviations of two or more letters)
    .replace(/\b(?:[a-z]\.){2,}/g, (m) => m.replace(/\./g, ""))
    // O'Brien -> obrien, D’Angelo -> dangelo
    .replace(/['’‘`´]/g, "");
}

function tokenize(s: string): string[] {
  return s.split(/[^a-z0-9]+/).filter(Boolean);
}

function endsWithSeq(tokens: string[], seq: string[]): boolean {
  if (seq.length > tokens.length) return false;
  for (let i = 0; i < seq.length; i++) if (tokens[tokens.length - seq.length + i] !== seq[i]) return false;
  return true;
}

/** Remove trailing suffixes (repeatedly), never emptying the name. Pushes what it removed onto `out`. */
function stripSuffixes(tokens: string[], out: string[]): string[] {
  const t = tokens.slice();
  let changed = true;
  while (changed && t.length > 1) {
    changed = false;
    for (const seq of SUFFIX_SEQS) {
      if (seq.length < t.length && endsWithSeq(t, seq)) {
        out.push(seq.join(" "));
        t.splice(t.length - seq.length);
        changed = true;
        break;
      }
    }
    if (changed) continue;
    // "L. L. C." written with spaces arrives as single letters: l l c
    for (let k = Math.min(4, t.length - 1); k >= 2; k--) {
      const tail = t.slice(t.length - k);
      if (tail.every((x) => x.length === 1) && SUFFIX_SINGLE.has(tail.join(""))) {
        out.push(tail.join(""));
        t.splice(t.length - k);
        changed = true;
        break;
      }
    }
    // a dangling "and" left by "Smith & Co."
    if (!changed && t.length > 1 && FILLER.has(t[t.length - 1])) {
      t.pop();
      changed = true;
    }
  }
  return t;
}

function isSuffixPart(part: string): boolean {
  const toks = tokenize(part);
  if (!toks.length) return true;
  const joined = toks.join(" ");
  return SUFFIX_SEQS.some((s) => s.join(" ") === joined) || (toks.every((x) => x.length === 1) && SUFFIX_SINGLE.has(toks.join("")));
}

/**
 * Normalise one name. `kind` is a hint: companies are never read as "Last, First".
 */
export function prepare(raw: string, kind?: NameKind | null): Prepared {
  const stripped: string[] = [];
  let s = fold(String(raw ?? ""));
  let reordered = false;

  // "Smith, John Q., Jr." -> "John Q. Smith" (suffix parts after commas are dropped first)
  const parts = s.split(",").map((p) => p.trim()).filter(Boolean);
  while (parts.length > 1 && isSuffixPart(parts[parts.length - 1])) stripped.push(tokenize(parts.pop()!).join(""));
  if (kind !== "company" && parts.length === 2) {
    const first = tokenize(parts[1]);
    if (first.length >= 1 && first.length <= 3) {
      s = parts[1] + " " + parts[0];
      reordered = true;
    } else s = parts.join(" ");
  } else s = parts.join(" ");

  let tokens = tokenize(s);
  // leading "The" and titles
  while (tokens.length > 1 && (tokens[0] === "the" || (kind !== "company" && TITLES.has(tokens[0])))) stripped.push(tokens.shift()!);
  tokens = stripSuffixes(tokens, stripped);
  return finish(raw, tokens, reordered, stripped);
}

function finish(raw: string, tokens: string[], reordered: boolean, stripped: string[]): Prepared {
  const n = tokens.length;
  const wPerson = tokens.map((t, i) => (i === 0 || i === n - 1 ? 1 : W_MIDDLE));
  const wCompany = tokens.map((t) => (FILLER.has(t) ? W_FILLER : GENERIC.has(t) ? W_GENERIC : 1));
  return {
    raw,
    tokens,
    joined: tokens.join(""),
    sortedKey: tokens.slice().sort().join(" "),
    reordered,
    stripped,
    wPerson,
    wCompany,
  };
}

// ----------------------------------------------------------- similarity

/**
 * Damerau-Levenshtein distance (optimal string alignment: adjacent transpositions count as one edit).
 * Stops early and returns max+1 once the distance must exceed `max`.
 */
export function damerauLevenshtein(a: string, b: string, max = Infinity): number {
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > max) return max + 1;
  if (la === 0) return lb;
  if (lb === 0) return la;
  let prev2 = new Array<number>(lb + 1).fill(0);
  let prev = new Array<number>(lb + 1);
  let cur = new Array<number>(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;
  for (let i = 1; i <= la; i++) {
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j <= lb; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a.charCodeAt(i - 1) === b.charCodeAt(j - 2) && a.charCodeAt(i - 2) === b.charCodeAt(j - 1)) {
        v = Math.min(v, prev2[j - 2] + 1);
      }
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    [prev2, prev, cur] = [prev, cur, prev2];
  }
  return prev[lb];
}

/** Jaro-Winkler similarity in [0, 1] (prefix scale 0.1, prefix up to 4 characters). */
export function jaroWinkler(a: string, b: string): number {
  if (a === b) return 1;
  const la = a.length;
  const lb = b.length;
  if (!la || !lb) return 0;
  const range = Math.max(0, Math.floor(Math.max(la, lb) / 2) - 1);
  const ma = new Array<boolean>(la).fill(false);
  const mb = new Array<boolean>(lb).fill(false);
  let m = 0;
  for (let i = 0; i < la; i++) {
    const lo = Math.max(0, i - range);
    const hi = Math.min(lb - 1, i + range);
    for (let j = lo; j <= hi; j++) {
      if (!mb[j] && a[i] === b[j]) {
        ma[i] = mb[j] = true;
        m++;
        break;
      }
    }
  }
  if (!m) return 0;
  let t = 0;
  let k = 0;
  for (let i = 0; i < la; i++) {
    if (!ma[i]) continue;
    while (!mb[k]) k++;
    if (a[i] !== b[k]) t++;
    k++;
  }
  const jaro = (m / la + m / lb + (m - t / 2) / m) / 3;
  let p = 0;
  while (p < 4 && p < la && p < lb && a[p] === b[p]) p++;
  return jaro + p * 0.1 * (1 - jaro);
}

/**
 * American Soundex code (letter + three digits). Used only as a weak "sounds alike" signal
 * for spellings an edit distance misses (Schneider / Snyder).
 */
export function soundex(s: string): string {
  const codes: Record<string, string> = {
    b: "1", f: "1", p: "1", v: "1", c: "2", g: "2", j: "2", k: "2", q: "2", s: "2", x: "2", z: "2",
    d: "3", t: "3", l: "4", m: "5", n: "5", r: "6",
  };
  const w = s.replace(/[^a-z]/g, "");
  if (!w) return "";
  let out = w[0].toUpperCase();
  let last = codes[w[0]] ?? "";
  for (let i = 1; i < w.length && out.length < 4; i++) {
    const ch = w[i];
    const code = codes[ch] ?? "";
    if (code && code !== last) out += code;
    // h and w do not separate letters with the same code; vowels do
    if (ch !== "h" && ch !== "w") last = code;
  }
  return out.padEnd(4, "0");
}

export type TokenRule = "exact" | "nickname" | "initial" | "typo" | "sounds alike" | "short form";
export interface TokenMatch {
  sim: number;
  rule: TokenRule;
}

/** Similarity given to each kind of token match. Tuned in tests/conflicts/names.test.ts. */
export const TOKEN_SIM = { exact: 1, nickname: 0.92, initial: 0.85, typoCap: 0.95, soundsAlike: 0.6, shortForm: 0.8 };

/**
 * Edits allowed between two tokens for them to count as a typo of each other:
 * none when either is under 3 letters or both are 3, one up to 7 letters, two from 8.
 * A two-edit match must also have Jaro-Winkler >= 0.88.
 */
export function allowedEdits(a: string, b: string): number {
  const min = Math.min(a.length, b.length);
  const max = Math.max(a.length, b.length);
  if (min < 3 || max < 4) return 0;
  return max >= 8 ? 2 : 1;
}
export const TYPO_JW_FLOOR = 0.88;

/** How alike two normalised tokens are, or null when they should not be paired at all. */
export function tokenSimilarity(a: string, b: string): TokenMatch | null {
  if (a === b) return { sim: TOKEN_SIM.exact, rule: "exact" };
  if (areNicknames(a, b)) return { sim: TOKEN_SIM.nickname, rule: "nickname" };
  if ((a.length === 1 && b.startsWith(a)) || (b.length === 1 && a.startsWith(b))) return { sim: TOKEN_SIM.initial, rule: "initial" };
  // digits must agree exactly: "Unit 12" is not a typo of "Unit 13"
  if (/\d/.test(a) || /\d/.test(b)) return null;
  const allowed = allowedEdits(a, b);
  if (allowed) {
    const d = damerauLevenshtein(a, b, allowed);
    const jw = d <= allowed ? jaroWinkler(a, b) : 0;
    if (d <= allowed && (d < 2 || jw >= TYPO_JW_FLOOR)) {
      return { sim: Math.min(TOKEN_SIM.typoCap, 0.5 * jw + 0.5 * (1 - d / Math.max(a.length, b.length))), rule: "typo" };
    }
  }
  if (a.length >= 5 && b.length >= 5 && soundex(a) === soundex(b)) return { sim: TOKEN_SIM.soundsAlike, rule: "sounds alike" };
  return null;
}

// ---------------------------------------------------------- name scores

export type NameRule =
  | "exact"
  | "suffix ignored"
  | "last, first"
  | "token order"
  | "spacing"
  | "nickname"
  | "initial"
  | "typo"
  | "sounds alike"
  | "short form"
  | "middle name differs"
  | "partial";

export interface NameScore {
  score: number;
  rules: NameRule[];
}

export type SimLookup = (a: string, b: string) => TokenMatch | null;

/**
 * Score how likely two names refer to the same person or company, 0..1.
 * `mode` is the kind of the stored name: it decides how tokens are weighted.
 *
 *  - Equal after normalisation: 1.0 (rules say whether suffixes/"Last, First" were involved).
 *  - Same tokens in another order: 0.97. Same letters with different spacing: 0.96.
 *  - Otherwise tokens are paired greedily by similarity and scored as a weighted Dice
 *    coefficient: sum(sim * (wq + wc)) / (sum wq + sum wc). Person names weight first and
 *    last tokens 1 and middle tokens 0.25; company names weight generic words 0.5 and
 *    filler words 0.2, so "Acme Widgets" vs "Acme Widgets of Kansas" stays high.
 */
export function scoreNames(q: Prepared, c: Prepared, mode: NameKind, sim: SimLookup = tokenSimilarity): NameScore {
  const extra: NameRule[] = [];
  if (q.stripped.length || c.stripped.length) extra.push("suffix ignored");
  if (q.reordered || c.reordered) extra.push("last, first");
  if (!q.tokens.length || !c.tokens.length) return { score: 0, rules: [] };
  const qt = q.tokens.join(" ");
  const ct = c.tokens.join(" ");
  if (qt === ct) return { score: 1, rules: ["exact", ...extra] };
  if (q.sortedKey === c.sortedKey) return { score: 0.97, rules: ["token order", ...extra] };
  if (q.joined === c.joined) return { score: 0.96, rules: ["spacing", ...extra] };

  const wq = mode === "person" ? q.wPerson : q.wCompany;
  const wc = mode === "person" ? c.wPerson : c.wCompany;
  const pairs: { i: number; j: number; m: TokenMatch }[] = [];
  for (let i = 0; i < q.tokens.length; i++) {
    for (let j = 0; j < c.tokens.length; j++) {
      const m = sim(q.tokens[i], c.tokens[j]);
      if (m) pairs.push({ i, j, m });
    }
  }
  // A person's given name written as its first few letters (Bart / Bartholomew, Ced / Cedric).
  // Only for the first token of a person's name, so surnames like Smith / Smithson never pair.
  if (mode === "person" && q.tokens.length > 1 && c.tokens.length > 1) {
    const a = q.tokens[0];
    const b = c.tokens[0];
    const [s1, s2] = a.length <= b.length ? [a, b] : [b, a];
    if (s1.length >= 3 && s1 !== s2 && s2.startsWith(s1) && !pairs.some((p) => p.i === 0 && p.j === 0)) {
      pairs.push({ i: 0, j: 0, m: { sim: TOKEN_SIM.shortForm, rule: "short form" } });
    }
  }
  if (!pairs.length) return { score: 0, rules: [] };
  // Best pairs first; on ties prefer pairing tokens in the same position from the end/start.
  pairs.sort((a, b) => b.m.sim - a.m.sim || Math.abs(a.i - a.j) - Math.abs(b.i - b.j));
  const usedQ = new Set<number>();
  const usedC = new Set<number>();
  let num = 0;
  const rules = new Set<NameRule>();
  for (const p of pairs) {
    if (usedQ.has(p.i) || usedC.has(p.j)) continue;
    usedQ.add(p.i);
    usedC.add(p.j);
    num += p.m.sim * (wq[p.i] + wc[p.j]);
    if (p.m.rule !== "exact") rules.add(p.m.rule);
  }
  const den = wq.reduce((s, x) => s + x, 0) + wc.reduce((s, x) => s + x, 0);
  // A match on nothing but initials and filler words is not a match.
  const solid = [...usedQ].some((i) => q.tokens[i].length > 1 && wq[i] >= W_GENERIC);
  if (!solid) return { score: 0, rules: [] };
  let unmatchedLight = false;
  let unmatchedHeavy = false;
  q.tokens.forEach((_, i) => {
    if (!usedQ.has(i)) wq[i] >= 1 ? (unmatchedHeavy = true) : (unmatchedLight = true);
  });
  c.tokens.forEach((_, j) => {
    if (!usedC.has(j)) wc[j] >= 1 ? (unmatchedHeavy = true) : (unmatchedLight = true);
  });
  if (unmatchedLight && mode === "person") rules.add("middle name differs");
  if (unmatchedHeavy || (unmatchedLight && mode === "company")) rules.add("partial");
  if (q.sortedKey !== c.sortedKey && !rules.size) rules.add("partial");
  const score = Math.round((num / den) * 1000) / 1000;
  return { score, rules: [...rules, ...extra] };
}

/** Convenience for tests and one-off comparisons. */
export function compareNames(a: string, b: string, kind: NameKind = "person"): NameScore {
  return scoreNames(prepare(a, kind), prepare(b, kind), kind);
}

/** Score bands used to label hits. */
export const BANDS = { strong: 0.93, possible: 0.8, weak: 0.6 };
export function band(score: number): "strong" | "possible" | "weak" | "none" {
  return score >= BANDS.strong ? "strong" : score >= BANDS.possible ? "possible" : score >= BANDS.weak ? "weak" : "none";
}
