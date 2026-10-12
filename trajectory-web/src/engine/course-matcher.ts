// ============================================================
// Course Matcher — Fuzzy-match a syllabus course name against
// existing ClassBlock entries and auto-create if no match found
// ============================================================

import { ClassBlock } from "./types";

// ── Normalization ─────────────────────────────────────────────

/** Common noise words to strip before comparison */
const STOP_WORDS = new Set([
  "the", "a", "an", "of", "to", "in", "for", "and", "or", "with",
  "introduction", "intro", "advanced", "fundamentals", "principles",
  "survey", "topics", "special", "applied", "theory",
  "i", "ii", "iii", "iv", "1", "2", "3", "4",
]);

/** Abbreviation expansions — expand common shorthand */
const EXPANSIONS: Record<string, string> = {
  calc: "calculus",
  bio: "biology",
  chem: "chemistry",
  phys: "physics",
  psych: "psychology",
  econ: "economics",
  eng: "english",
  hist: "history",
  math: "mathematics",
  cs: "computer science",
  compsci: "computer science",
  stats: "statistics",
  stat: "statistics",
  orgo: "organic chemistry",
  lit: "literature",
  phil: "philosophy",
  poli: "political",
  sci: "science",
  mgmt: "management",
  acct: "accounting",
  fin: "finance",
  mkt: "marketing",
  hr: "human resources",
  ops: "operations",
  ling: "linguistics",
  anthro: "anthropology",
  soc: "sociology",
  env: "environmental",
  arch: "architecture",
};

/**
 * Normalize a course name into a set of meaningful tokens.
 * Strips punctuation, lowercases, expands abbreviations, removes stop words.
 */
export function normalizeCourse(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")  // strip punctuation
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => EXPANSIONS[token] ?? token)  // expand abbreviations
    .flatMap((token) => token.split(/\s+/))       // re-split after expansion
    .filter((token) => !STOP_WORDS.has(token) && token.length > 1);
}

// ── Scoring ───────────────────────────────────────────────────

/**
 * Compute a similarity score [0, 1] between two course name token sets.
 * Uses Jaccard similarity on token overlap, boosted by substring containment.
 * e.g., "micro" ⊂ "microeconomics" counts as a partial match.
 */
export function courseMatchScore(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);

  // Exact token intersection
  let exactIntersection = 0;
  for (const token of setA) {
    if (setB.has(token)) exactIntersection++;
  }

  // Substring containment bonus: token from A is a prefix/substring of a token in B or vice versa
  let substringBonus = 0;
  for (const ta of setA) {
    for (const tb of setB) {
      if (ta !== tb && (ta.includes(tb) || tb.includes(ta)) && Math.min(ta.length, tb.length) >= 4) {
        substringBonus += 0.5;
        break;
      }
    }
  }

  const union = new Set([...setA, ...setB]).size;
  if (union === 0) return 0;
  const jaccard = exactIntersection / union;
  // substringBonus is already a count of partial matches; normalize by union
  const bonus = substringBonus / union;
  return Math.min(1, jaccard + bonus);
}

// ── Public API ────────────────────────────────────────────────

export interface CourseMatchResult {
  /** The best matching class, or null if no match above threshold */
  matchedClass: ClassBlock | null;
  /** Similarity score of the best match [0, 1] */
  score: number;
  /** Whether the match is confident enough to auto-link */
  isConfident: boolean;
}

/** "CHEM 201", "econ-101a", "MATH2410": 2-5 letters then 3-4 digits (and an optional letter). */
const COURSE_CODE = /\b[A-Za-z]{2,5}[\s-]?\d{3,4}[A-Za-z]?\b/g;

/** Every course code in a piece of text, compacted to letters and digits only so "chem-201" equals "CHEM 201". */
function codesIn(text: string): Set<string> {
  return new Set((text.match(COURSE_CODE) ?? []).map((code) => code.toUpperCase().replace(/[^A-Z0-9]/g, "")));
}

/** Minimum score to consider a match "confident" (Jaccard + substring bonus) */
const CONFIDENT_THRESHOLD = 0.3;

/**
 * Find the best matching class for a given course name.
 * Returns the matched class and confidence level.
 */
export function findBestClassMatch(
  courseName: string,
  classes: ClassBlock[],
  courseCode?: string
): CourseMatchResult {
  if (classes.length === 0) {
    return { matchedClass: null, score: 0, isConfident: false };
  }

  // A course code ("CHEM 201") is the strongest identity a syllabus has: when a class already carries it in its
  // name, that class is the match regardless of how the title is worded.
  const codeKeys = new Set([...codesIn(courseCode ?? ""), ...codesIn(courseName)]);
  if (codeKeys.size > 0) {
    const byCode = classes.find((cls) => [...codesIn(cls.name)].some((code) => codeKeys.has(code)));
    if (byCode) return { matchedClass: byCode, score: 1, isConfident: true };
  }

  const queryTokens = normalizeCourse(courseName);
  if (queryTokens.length === 0) {
    return { matchedClass: null, score: 0, isConfident: false };
  }

  let bestClass: ClassBlock | null = null;
  let bestScore = 0;

  for (const cls of classes) {
    const classTokens = normalizeCourse(cls.name);
    const score = courseMatchScore(queryTokens, classTokens);
    if (score > bestScore) {
      bestScore = score;
      bestClass = cls;
    }
  }

  return {
    matchedClass: bestScore >= CONFIDENT_THRESHOLD ? bestClass : null,
    score: bestScore,
    isConfident: bestScore >= CONFIDENT_THRESHOLD,
  };
}

// ── Verified Class Builder ─────────────────────────────────────

/** Course colors to cycle through for syllabus-created classes */
const AUTO_CLASS_COLORS = [
  "#4F6EF7", "#8B5CF6", "#EC4899", "#F59E0B",
  "#22C55E", "#06B6D4", "#EF4444", "#F97316",
];

/**
 * Build a new ClassBlock only after the user verifies its meeting pattern.
 * A class with no meeting days is not a valid scheduling constraint.
 */
export function buildVerifiedClassFromSyllabus(
  courseName: string,
  existingClassCount: number,
  meeting: Pick<ClassBlock, "days" | "startTime" | "endTime" | "location" | "isAsynchronous">
): Omit<ClassBlock, "id"> {
  const colorIndex = existingClassCount % AUTO_CLASS_COLORS.length;
  return {
    name: courseName,
    days: meeting.days,
    startTime: meeting.startTime,
    endTime: meeting.endTime,
    location: meeting.location?.trim() || undefined,
    isAsynchronous: meeting.isAsynchronous || undefined,
    color: AUTO_CLASS_COLORS[colorIndex],
  };
}
