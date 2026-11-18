// Name matching rules. Every name here is made up.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BANDS, band, compareNames, damerauLevenshtein, fold, jaroWinkler, prepare, soundex, splitNames, tokenSimilarity,
} from "../../src/conflicts/names.ts";

test("normalising: case, punctuation, accents, ampersands", () => {
  assert.equal(fold("José Núñez-Peña"), "jose nunez-pena");
  assert.equal(fold("Smørrebrød Straße"), "smorrebrod strasse");
  assert.deepEqual(prepare("O'BRIEN & SONS, L.L.C.", "company").tokens, ["obrien", "and", "sons"]);
  assert.deepEqual(prepare("D’Angelo, Maria").tokens, ["maria", "dangelo"]);
  assert.deepEqual(prepare("  The   Wichita  Eagle  Co. ", "company").tokens, ["wichita", "eagle"]);
});

test("normalising: company suffixes are stripped from the end, however written", () => {
  const forms = [
    "Prairie Wind LLC", "Prairie Wind, L.L.C.", "Prairie Wind L L C", "Prairie Wind, Inc.", "Prairie Wind Incorporated",
    "Prairie Wind Corp.", "Prairie Wind Corporation", "Prairie Wind Co.", "Prairie Wind Company", "Prairie Wind Ltd",
    "Prairie Wind, LLP", "Prairie Wind P.A.", "Prairie Wind, Chartered", "Prairie Wind Chtd.", "Prairie Wind PLLC",
    "Prairie Wind LC", "Prairie Wind, P.C.", "Prairie Wind Professional Association", "Prairie Wind Limited Liability Company",
    "The Prairie Wind Company", "Prairie Wind, Inc., a Kansas corporation".replace(", a Kansas corporation", ""),
  ];
  for (const f of forms) assert.deepEqual(prepare(f, "company").tokens, ["prairie", "wind"], f);
  // never strips a name down to nothing, and only from the end
  assert.deepEqual(prepare("Company", "company").tokens, ["company"]);
  assert.deepEqual(prepare("Co-op Grain Inc", "company").tokens, ["co", "op", "grain"]);
});

test("normalising: Last, First, titles and personal suffixes", () => {
  assert.deepEqual(prepare("Smith, John Q., Jr.").tokens, ["john", "q", "smith"]);
  assert.ok(prepare("Smith, John").reordered);
  assert.deepEqual(prepare("Dr. Anne Marie Keller, M.D.").tokens, ["anne", "marie", "keller"]);
  assert.deepEqual(prepare("Robert Lee III").tokens, ["robert", "lee"]);
  // companies are never read as Last, First
  assert.deepEqual(prepare("Acme, Inc.", "company").tokens, ["acme"]);
  assert.deepEqual(prepare("Baker, Hale & Moss", "company").tokens, ["baker", "hale", "and", "moss"]);
});

test("normalising: text in brackets is a note, not part of the name", () => {
  assert.deepEqual(prepare("John Smith (deceased)").tokens, ["john", "smith"]);
  assert.deepEqual(prepare("Smith, John (deceased)").tokens, ["john", "smith"]);
  assert.deepEqual(prepare("Acme Supply LLC [old address]", "company").tokens, ["acme", "supply"]);
  assert.deepEqual(prepare("Mary {estate} Ellis").tokens, ["mary", "ellis"]);
  assert.deepEqual(prepare("John Smith (deceased)").stripped, [], "a bracketed note is not reported as a suffix");
  // a name that is all brackets is kept rather than emptied
  assert.deepEqual(prepare("(unknown)").tokens, ["unknown"]);
  // the note no longer weakens the match
  assert.equal(compareNames("John Smith (deceased)", "John Smith").score, compareNames("John Smith", "John Smith").score);
});

test("splitting names that carry other names", () => {
  assert.deepEqual(splitNames("John Smith d/b/a Smith Plumbing"), ["John Smith", "Smith Plumbing"]);
  assert.deepEqual(splitNames("Jane Doe f/k/a Jane Roe"), ["Jane Doe", "Jane Roe"]);
  assert.deepEqual(splitNames("Kaw Valley Feed DBA KV Feed & Seed"), ["Kaw Valley Feed", "KV Feed & Seed"]);
  assert.deepEqual(splitNames("Mary Ellis a/k/a Molly Ellis"), ["Mary Ellis", "Molly Ellis"]);
  assert.deepEqual(splitNames("Adair Holdings"), ["Adair Holdings"]);
  assert.deepEqual(splitNames("Akard Farms"), ["Akard Farms"], "'aka' inside a word is not a separator");
});

test("edit distance and Jaro-Winkler", () => {
  assert.equal(damerauLevenshtein("smith", "smith"), 0);
  assert.equal(damerauLevenshtein("smith", "smtih"), 1, "adjacent transposition is one edit");
  assert.equal(damerauLevenshtein("johnson", "jonson"), 1);
  assert.equal(damerauLevenshtein("smith", "smithson"), 3);
  assert.equal(damerauLevenshtein("smith", "smithson", 1), 2, "stops early past the limit");
  assert.ok(Math.abs(jaroWinkler("martha", "marhta") - 0.961) < 0.001);
  assert.ok(Math.abs(jaroWinkler("dwayne", "duane") - 0.84) < 0.001);
  assert.equal(jaroWinkler("abc", "abc"), 1);
  assert.equal(jaroWinkler("abc", "xyz"), 0);
  assert.equal(soundex("robert"), "R163");
  assert.equal(soundex("rupert"), "R163");
  assert.equal(soundex("ashcraft"), "A261");
  assert.equal(soundex("schneider"), soundex("snyder"));
});

test("token rules: nicknames, initials, typos, sounds-alike", () => {
  assert.equal(tokenSimilarity("bill", "william")?.rule, "nickname");
  assert.equal(tokenSimilarity("bob", "robert")?.rule, "nickname");
  assert.equal(tokenSimilarity("liz", "elizabeth")?.rule, "nickname");
  assert.equal(tokenSimilarity("kate", "katherine")?.rule, "nickname");
  assert.equal(tokenSimilarity("kate", "catherine")?.rule, "nickname");
  assert.equal(tokenSimilarity("peggy", "margaret")?.rule, "nickname");
  assert.equal(tokenSimilarity("j", "john")?.rule, "initial");
  assert.equal(tokenSimilarity("smyth", "smith")?.rule, "typo");
  assert.equal(tokenSimilarity("katz", "kats")?.rule, "typo");
  assert.equal(tokenSimilarity("hernandez", "hernandes")?.rule, "typo");
  assert.equal(tokenSimilarity("schneider", "snyder")?.rule, "sounds alike");
  // not paired at all
  assert.equal(tokenSimilarity("tom", "tim"), null, "three-letter words need to match exactly");
  assert.equal(tokenSimilarity("smith", "smithson"), null);
  assert.equal(tokenSimilarity("jensen", "hansen"), null);
  assert.equal(tokenSimilarity("12", "13"), null);
  assert.equal(tokenSimilarity("john", "jane"), null, "sounds-alike needs five letters");
});

/** [query, stored name, kind, expected band, rule that must be among the rules] */
const SHOULD_FLAG: [string, string, "person" | "company", "strong" | "possible" | "weak", string][] = [
  // people
  ["John Smith", "John Smith", "person", "strong", "exact"],
  ["JOHN SMITH", "john smith", "person", "strong", "exact"],
  ["Smith, John", "John Smith", "person", "strong", "last, first"],
  ["Smith John", "John Smith", "person", "strong", "token order"],
  ["John Q. Smith", "John Smith", "person", "strong", "middle name differs"],
  ["Smith, John Q.", "John Smith", "person", "strong", "middle name differs"],
  ["John Quincy Smith", "John Q Smith", "person", "strong", "initial"],
  ["John Smith Jr.", "John Smith", "person", "strong", "suffix ignored"],
  ["Bill Smith", "William Smith", "person", "strong", "nickname"],
  ["Bob Kowalski", "Robert Kowalski", "person", "strong", "nickname"],
  ["Liz Walker", "Elizabeth Walker", "person", "strong", "nickname"],
  ["Kate Brennan", "Katherine Brennan", "person", "strong", "nickname"],
  ["Peggy Olsen", "Margaret Olson", "person", "possible", "typo"],
  ["J. Smith", "John Smith", "person", "possible", "initial"],
  ["Jon Smyth", "John Smith", "person", "possible", "typo"],
  ["Micheal Schmitt", "Michael Schmidt", "person", "possible", "typo"],
  ["Catherine Hernandes", "Kathryn Hernandez", "person", "possible", "typo"],
  ["José Núñez", "Jose Nunez", "person", "strong", "exact"],
  ["Patrick O'Brien", "Pat OBrien", "person", "strong", "nickname"],
  ["Ronald McDonald", "Ronald Mc Donald", "person", "strong", "spacing"],
  ["Mary Smith-Jones", "Mary Jones", "person", "strong", "middle name differs"],
  // maiden name kept as a middle name: still flagged, but only weakly because "jones" is unmatched
  ["Mary Smith Jones", "Mary Smith", "person", "weak", "partial"],
  ["Elizabeth Ann Walker", "Liz Walker", "person", "possible", "nickname"],
  ["John A. Smith", "John B. Smith", "person", "possible", "middle name differs"],
  ["Chris Snyder", "Christopher Schneider", "person", "weak", "sounds alike"],
  ["Smith", "John Smith", "person", "weak", "partial"],
  ["Dr. Anne Keller", "Keller, Anne M.", "person", "strong", "last, first"],
  ["Stephen Lindqvist", "Steven Lindquist", "person", "possible", "typo"],
  ["Ced Anderson", "Cedric Anderson", "person", "possible", "short form"],
  ["Bart Quackenbush", "Bartholomew Quackenbush", "person", "strong", "nickname"],
  // companies
  ["Acme Widgets, L.L.C.", "ACME WIDGETS LLC", "company", "strong", "exact"],
  ["Acme Widgets Inc", "Acme Widgets, LLC", "company", "strong", "suffix ignored"],
  ["The Boeing Company", "Boeing", "company", "strong", "suffix ignored"],
  ["Smith & Co.", "Smith and Company", "company", "strong", "exact"],
  ["Johnson Farms", "Johnston Farms", "company", "strong", "typo"],
  ["Acme Widgets of Kansas", "Acme Widgets", "company", "possible", "partial"],
  ["Smith", "Smith Construction", "company", "possible", "partial"],
  ["Sunflower Bank", "Sunflwoer Bank, N.A.", "company", "strong", "typo"],
  ["Kaw Valley Grain", "Kaw Vally Grain Co-op", "company", "strong", "typo"],
  ["Smith Construction LLC", "Smith Consulting, Inc.", "company", "weak", "partial"],
];

for (const [q, c, kind, expected, rule] of SHOULD_FLAG) {
  test(`flags ${JSON.stringify(q)} ~ ${JSON.stringify(c)} as ${expected} (${rule})`, () => {
    const s = compareNames(q, c, kind);
    assert.equal(band(s.score), expected, `score ${s.score}, rules ${s.rules.join(", ")}`);
    assert.ok(s.rules.includes(rule as any), `expected rule ${rule}, got ${s.rules.join(", ")}`);
    // symmetric enough that the order of entry does not hide a hit
    assert.equal(band(compareNames(c, q, kind).score) !== "none", true, "reverse direction also flags");
  });
}

/** False-positive controls: these must not be flagged (score below the weak band). */
const SHOULD_NOT_FLAG: [string, string, "person" | "company"][] = [
  // Documents what happens: "smith" and "smithson" are three edits apart and
  // "construction"/"consulting" are not close, so nothing pairs and the score is 0.
  ["Smith Construction", "Smithson Consulting", "company"],
  ["John Smith", "Jane Smith", "person"],
  ["John Smith", "John Brown", "person"],
  ["Tom Jensen", "Tom Hansen", "person"],
  ["Unit 12 LLC", "Unit 13 LLC", "company"],
  ["Kansas Title Company", "Kansas City Royals", "company"],
  ["Prairie Wind Energy", "Prairie Fire Coffee", "company"],
  ["A. B. Carter", "C. D. Jones", "person"],
  // the short-form rule is for given names only: surnames that start alike do not pair
  ["Smith", "Smithson", "person"],
  ["Ann Smith", "Ann Smithson", "person"],
];

for (const [q, c, kind] of SHOULD_NOT_FLAG) {
  test(`does not flag ${JSON.stringify(q)} ~ ${JSON.stringify(c)}`, () => {
    const s = compareNames(q, c, kind);
    assert.ok(s.score < BANDS.weak, `score ${s.score}, rules ${s.rules.join(", ")}`);
  });
}

test("documented scores for the Smith look-alikes", () => {
  assert.equal(compareNames("Smith Construction", "Smithson Consulting", "company").score, 0);
  // Same family word, different trade: a weak hit, so a lawyer still sees it.
  const sc = compareNames("Smith Construction", "Smith Consulting", "company").score;
  assert.ok(sc >= BANDS.weak && sc < BANDS.possible, String(sc));
  // Shared surname alone between two people is not a hit (0.5).
  assert.equal(compareNames("John Smith", "Jane Smith", "person").score, 0.5);
});
