// Plain-English wording for conflict-check results, shared by the screens and the
// printed report. The search (src/conflicts/search.ts) explains each hit with rule names
// and scores; a lawyer reading the file wants sentences.

import type { Hit } from "../conflicts/search.ts";
import { ROLE_LABELS, type PartyRole } from "../conflicts/store.ts";

/** What each matching rule means, finishing the sentence "… is close to X: …". */
export const RULE_WORDS: Record<string, string> = {
  exact: "the same name",
  "suffix ignored": "the same name apart from an ending such as LLC, Inc. or Jr.",
  "last, first": "the same name written last name first",
  "token order": "the same words in a different order",
  spacing: "the same name spaced differently",
  nickname: "a common nickname for the same first name",
  initial: "an initial in place of a name",
  typo: "a likely misspelling",
  "sounds alike": "a name that sounds alike",
  "short form": "a shortened form of the name",
  "middle name differs": "a different or missing middle name",
  partial: "only part of the name matches",
};

export const BAND_LABELS = { strong: "Strong match", possible: "Possible match", weak: "Weak match" } as const;

export const DECISION_LABELS: Record<string, string> = {
  cleared: "Cleared",
  waived: "Waived",
  declined: "Declined",
};

const ALIAS_WORDS: Record<string, string> = {
  former_name: "former name",
  maiden_name: "maiden name",
  dba: "trade name (d/b/a)",
  trade_name: "trade name",
  nickname: "nickname",
  misspelling: "known misspelling",
  other: "other name",
};

export function roleLabel(role: string | null | undefined): string {
  return role ? ROLE_LABELS[role as PartyRole] ?? role.replace(/_/g, " ") : "";
}

function cap(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

function possessive(name: string): string {
  return /s$/i.test(name) ? `${name}’` : `${name}’s`;
}

function list(xs: string[]): string {
  if (xs.length <= 1) return xs.join("");
  return xs.slice(0, -1).join(", ") + " and " + xs[xs.length - 1];
}

/** The sentences that explain one hit, most important first. */
export function plainReasons(hit: Hit): string[] {
  const out: string[] = [];
  for (const m of hit.matches ?? []) {
    const how = list((m.rules.length ? m.rules : ["exact"]).map((r) => RULE_WORDS[r] ?? r));
    const exact = !m.rules.length || (m.rules.length === 1 && m.rules[0] === "exact");
    if (m.via === "alias" && m.aliasKind && m.aliasKind !== "also known as") {
      const kind = ALIAS_WORDS[m.aliasKind] ?? "other name";
      out.push(
        exact
          ? `“${m.term}” is recorded as ${possessive(hit.name)} ${kind}.`
          : `“${m.term}” is close to “${m.matchedName}”, ${possessive(hit.name)} ${kind}: ${how}.`,
      );
    } else if (m.via === "alias") {
      out.push(exact ? `“${m.term}” is one of the names ${hit.name} goes by.` : `“${m.term}” is close to “${m.matchedName}”, a name ${hit.name} goes by: ${how}.`);
    } else {
      out.push(exact ? `“${m.term}” matches this name exactly.` : `“${m.term}” is close to ${hit.name}: ${how}.`);
    }
  }
  for (const r of hit.relations ?? []) out.push(`Connected by a recorded relationship: ${r.text}.`);
  for (const i of hit.involvements ?? []) {
    const when = i.status === "closed" ? `closed${i.closedOn ? " " + String(i.closedOn).slice(0, 4) : ""}` : "open";
    out.push(`${cap(roleLabel(i.role))} in matter ${i.matter} (${when}).`);
  }
  if (hit.onProposedMatter?.length) out.push(`Already on this matter as ${list(hit.onProposedMatter.map(roleLabel))}.`);
  if (!hit.involvements?.length && !hit.relations?.length) out.push("Not on any matter.");
  return out;
}

/** Hits with the plain sentences attached, ready for the screens. */
export function withPlain(hits: Hit[]): (Hit & { plain: string[]; bandLabel: string })[] {
  return hits.map((h) => ({ ...h, plain: plainReasons(h), bandLabel: BAND_LABELS[h.band] ?? h.band }));
}

export function bandCounts(hits: { band: string }[]): { strong: number; possible: number; weak: number } {
  const c = { strong: 0, possible: 0, weak: 0 };
  for (const h of hits) if (h.band in c) c[h.band as keyof typeof c]++;
  return c;
}

/** "2 strong, 1 possible" or "No matches". */
export function countsText(c: { strong: number; possible: number; weak: number }): string {
  const parts = (["strong", "possible", "weak"] as const).filter((b) => c[b]).map((b) => `${c[b]} ${b}`);
  return parts.length ? parts.join(", ") : "No matches";
}
