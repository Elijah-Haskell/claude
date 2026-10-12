import { describe, expect, it } from "vitest";
import {
  correctAnswerText,
  gradeResponse,
  identityOrder,
  isGradable,
  letterGrade,
  parseBoolean,
  resolveAnswer,
  scoreExam,
  shuffledOrder,
  stripOptionPrefix,
  type QuestionLike,
} from "../../src/engine/practice-exam-scoring";

const PLAIN = ["Mitochondria", "Ribosome", "Nucleus", "Golgi body"];
const PREFIXED = ["A) Mitochondria", "B) Ribosome", "C) Nucleus", "D) Golgi body"];

const mc = (over: Partial<QuestionLike> = {}): QuestionLike => ({
  type: "multiple_choice",
  options: PLAIN,
  answer: "Ribosome",
  answerIndex: 1,
  ...over,
});

describe("resolveAnswer: the answerIndex contract", () => {
  it("scores by answerIndex", () => {
    const key = resolveAnswer(mc({ answerIndex: 2, answer: "ignored text" }));
    expect(key).toMatchObject({ kind: "choice", index: 2, source: "answerIndex" });
  });

  it("answerIndex 0 is a real answer, not 'missing'", () => {
    expect(resolveAnswer(mc({ answerIndex: 0, answer: "" }))).toMatchObject({ kind: "choice", index: 0 });
  });

  it("an out-of-range answerIndex is not trusted; the answer text decides", () => {
    expect(resolveAnswer(mc({ answerIndex: 7, answer: "Nucleus" }))).toMatchObject({ kind: "choice", index: 2, source: "text" });
    expect(resolveAnswer(mc({ answerIndex: -1, answer: "Nucleus" }))).toMatchObject({ kind: "choice", index: 2 });
    expect(resolveAnswer(mc({ answerIndex: 1.5, answer: "Golgi body" }))).toMatchObject({ kind: "choice", index: 3 });
  });
});

describe("resolveAnswer: exams saved before the contract (letters and text)", () => {
  it.each([
    ["B", 1],
    ["b", 1],
    ["B)", 1],
    ["(B)", 1],
    ["B.", 1],
    [" c ", 2],
    ["D", 3],
  ])("letter answer %j on prefixed options -> index %i (this was always scored wrong before)", (answer, index) => {
    const key = resolveAnswer({ type: "multiple_choice", options: PREFIXED, answer });
    expect(key).toMatchObject({ kind: "choice", index });
  });

  it("letter answers also work on unprefixed options", () => {
    expect(resolveAnswer({ type: "multiple_choice", options: PLAIN, answer: "C" })).toMatchObject({ kind: "choice", index: 2, source: "letter" });
  });

  it("'B) Ribosome' resolves by its text, and its letter when the text is missing from the options", () => {
    expect(resolveAnswer({ type: "multiple_choice", options: PREFIXED, answer: "B) Ribosome" })).toMatchObject({ index: 1 });
    expect(resolveAnswer({ type: "multiple_choice", options: PLAIN, answer: "D) something else" })).toMatchObject({ index: 3, source: "letter" });
  });

  it("the correct option's text (with or without the letter prefix, any case/spacing) resolves", () => {
    expect(resolveAnswer({ type: "multiple_choice", options: PREFIXED, answer: "Nucleus" })).toMatchObject({ index: 2 });
    expect(resolveAnswer({ type: "multiple_choice", options: PREFIXED, answer: "  c)  nucleus. " })).toMatchObject({ index: 2 });
    expect(resolveAnswer({ type: "multiple_choice", options: PLAIN, answer: "golgi   BODY" })).toMatchObject({ index: 3 });
  });

  it("an option that literally starts with a letter and a period ('A. Smith') is not mangled", () => {
    const options = ["A. Smith", "Karl Marx", "J. M. Keynes", "D. Ricardo"];
    expect(resolveAnswer({ type: "multiple_choice", options, answer: "A. Smith" })).toMatchObject({ index: 0 });
  });
});

describe("resolveAnswer: missing, broken and odd answer keys", () => {
  it("no answer key at all -> ungradable, never 'wrong'", () => {
    expect(resolveAnswer({ type: "multiple_choice", options: PLAIN, answer: "" })).toMatchObject({ kind: "unknown" });
    expect(resolveAnswer({ type: "multiple_choice", options: PLAIN, answer: undefined as unknown as string })).toMatchObject({ kind: "unknown" });
  });

  it("an answer that matches no option -> ungradable", () => {
    expect(resolveAnswer({ type: "multiple_choice", options: PLAIN, answer: "Chloroplast" })).toMatchObject({ kind: "unknown" });
  });

  it("a letter beyond the options -> ungradable", () => {
    expect(resolveAnswer({ type: "multiple_choice", options: PLAIN, answer: "F" })).toMatchObject({ kind: "unknown" });
    expect(resolveAnswer({ type: "multiple_choice", options: ["a", "b", "c"], answer: "D" })).toMatchObject({ kind: "unknown" });
  });

  it("missing / non-array / junk options -> ungradable (no crash)", () => {
    for (const options of [undefined, null, "A) x", 5, [], ["only one"], ["a", "", "c", "d"], ["a", 2, "c", "d"], Array(20).fill("x")]) {
      expect(resolveAnswer({ type: "multiple_choice", options, answer: "A" }).kind).toBe("unknown");
    }
  });

  it("fewer than 4 options is fine for a saved exam (3 options and 2 options both score)", () => {
    expect(resolveAnswer({ type: "multiple_choice", options: ["Yes", "No", "Maybe"], answer: "C" })).toMatchObject({ kind: "choice", index: 2 });
    expect(resolveAnswer({ type: "multiple_choice", options: ["Yes", "No"], answerIndex: 1, answer: "No" })).toMatchObject({ kind: "choice", index: 1 });
  });

  it("an unknown question type is ungradable", () => {
    expect(resolveAnswer({ type: "essay" as never, answer: "x" }).kind).toBe("unknown");
  });
});

describe("duplicate options", () => {
  const options = ["Paris", "Lyon", "Paris", "Nice"];

  it("either identical option counts as correct, so a duplicate can't cost a student the point", () => {
    const q: QuestionLike = { type: "multiple_choice", options, answerIndex: 0, answer: "Paris" };
    expect(gradeResponse(q, { selectedIndex: 0 })).toBe(true);
    expect(gradeResponse(q, { selectedIndex: 2 })).toBe(true);
    expect(gradeResponse(q, { selectedIndex: 1 })).toBe(false);
  });

  it("a text answer that matches two options resolves to both", () => {
    const key = resolveAnswer({ type: "multiple_choice", options, answer: "Paris" });
    expect(key).toMatchObject({ kind: "choice", index: 0, indexes: [0, 2] });
  });

  it("options that differ only by letter prefix / case are the same text", () => {
    const q: QuestionLike = { type: "multiple_choice", options: ["A) Paris", "B) Lyon", "C) paris", "D) Nice"], answer: "A" };
    expect(resolveAnswer(q)).toMatchObject({ indexes: [0, 2] });
  });
});

describe("gradeResponse", () => {
  it("multiple choice compares the ORIGINAL option index", () => {
    const q = mc({ answerIndex: 1 });
    expect(gradeResponse(q, { selectedIndex: 1 })).toBe(true);
    expect(gradeResponse(q, { selectedIndex: 0 })).toBe(false);
  });

  it("legacy letter exam: picking the right option is correct", () => {
    const q: QuestionLike = { type: "multiple_choice", options: PREFIXED, answer: "B" };
    expect(gradeResponse(q, { selectedIndex: 1 })).toBe(true);
    expect(gradeResponse(q, { selectedIndex: 3 })).toBe(false);
  });

  it("no response, or an unanswerable key, is null (not false)", () => {
    expect(gradeResponse(mc(), undefined)).toBeNull();
    expect(gradeResponse(mc(), {})).toBeNull();
    expect(gradeResponse({ type: "multiple_choice", options: PLAIN, answer: "" }, { selectedIndex: 1 })).toBeNull();
  });

  it("true / false accepts the many spellings of the key", () => {
    for (const [answer, value] of [["True", true], ["true.", true], ["T", true], ["False", false], [" false ", false], ["F", false]] as const) {
      const q: QuestionLike = { type: "true_false", answer };
      expect(gradeResponse(q, { selectedBoolean: value })).toBe(true);
      expect(gradeResponse(q, { selectedBoolean: !value })).toBe(false);
    }
    expect(resolveAnswer({ type: "true_false", answer: "maybe" }).kind).toBe("unknown");
  });

  it("parseBoolean handles real booleans and junk", () => {
    expect(parseBoolean(true)).toBe(true);
    expect(parseBoolean(false)).toBe(false);
    expect(parseBoolean("Yes")).toBeNull();
    expect(parseBoolean(1)).toBeNull();
  });

  it("short answers are self-graded, never auto-correct", () => {
    const q: QuestionLike = { type: "short_answer", answer: "Because of osmosis." };
    expect(resolveAnswer(q).kind).toBe("self");
    expect(gradeResponse(q, { selfRating: "got_it" })).toBeNull();
  });
});

describe("shuffled options", () => {
  it("shuffledOrder is a permutation, injectable RNG, and deterministic for a fixed RNG", () => {
    const rng = (() => { let n = 0; return () => [0.9, 0.1, 0.5, 0.3][n++ % 4]!; })();
    const order = shuffledOrder(4, rng);
    expect([...order].sort()).toEqual([0, 1, 2, 3]);
    let n = 0;
    const rng2 = () => [0.9, 0.1, 0.5, 0.3][n++ % 4]!;
    expect(shuffledOrder(4, rng2)).toEqual(order);
    expect(shuffledOrder(0)).toEqual([]);
    expect(identityOrder(3)).toEqual([0, 1, 2]);
  });

  it("a permutation of any RNG output is always a valid permutation", () => {
    for (let seed = 0; seed < 50; seed++) {
      let s = seed + 1;
      const rng = () => ((s = (s * 48271) % 2147483647) / 2147483647);
      const order = shuffledOrder(6, rng);
      expect([...order].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5]);
    }
  });

  it("whatever order the options are DISPLAYED in, scoring uses the original index", () => {
    const q = mc({ answerIndex: 1 }); // Ribosome
    const order = [3, 1, 0, 2]; // displayed: Golgi, Ribosome, Mitochondria, Nucleus
    const shown = order.map((i) => (q.options as string[])[i]);
    const tappedPosition = shown.indexOf("Ribosome");
    const original = order[tappedPosition]!;
    expect(gradeResponse(q, { selectedIndex: original })).toBe(true);
    // Tapping the option at the position where the correct one used to be (position 1 = "Ribosome" here by coincidence) vs another
    const wrongPosition = shown.indexOf("Nucleus");
    expect(gradeResponse(q, { selectedIndex: order[wrongPosition]! })).toBe(false);
  });

  it("every one of the 24 orderings marks exactly the Ribosome tap as correct", () => {
    const perms: number[][] = [];
    const permute = (rest: number[], acc: number[]) => (rest.length === 0 ? perms.push(acc) : rest.forEach((r, i) => permute([...rest.slice(0, i), ...rest.slice(i + 1)], [...acc, r])));
    permute([0, 1, 2, 3], []);
    expect(perms).toHaveLength(24);
    for (const order of perms) {
      const q = mc({ answerIndex: 1 });
      const results = order.map((original) => gradeResponse(q, { selectedIndex: original }));
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(results[order.indexOf(1)]).toBe(true);
    }
  });
});

describe("correctAnswerText", () => {
  it("shows the resolved option with its letter, whichever format was saved", () => {
    expect(correctAnswerText(mc({ answerIndex: 2 }))).toBe("C) Nucleus");
    expect(correctAnswerText({ type: "multiple_choice", options: PREFIXED, answer: "B" })).toBe("B) Ribosome");
    expect(correctAnswerText({ type: "true_false", answer: "false" })).toBe("False");
    expect(correctAnswerText({ type: "short_answer", answer: "A model answer." })).toBe("A model answer.");
    expect(correctAnswerText({ type: "multiple_choice", options: PLAIN, answer: "" })).toBe("Not available");
  });

  it("stripOptionPrefix only removes a leading letter marker", () => {
    expect(stripOptionPrefix("A) Foo")).toBe("Foo");
    expect(stripOptionPrefix("(b) Foo")).toBe("Foo");
    expect(stripOptionPrefix("Foo")).toBe("Foo");
    expect(stripOptionPrefix("B)Foo")).toBe("B)Foo");
  });
});

describe("scoreExam", () => {
  const questions: QuestionLike[] = [
    mc({ answerIndex: 1 }), // 0 MC
    { type: "true_false", answer: "True" }, // 1 TF
    { type: "short_answer", answer: "model answer" }, // 2 SA
    { type: "multiple_choice", options: PLAIN, answer: "" }, // 3 ungradable
    { type: "multiple_choice", options: PREFIXED, answer: "D" }, // 4 legacy letter
  ];

  it("counts auto-graded and self-graded questions separately and excludes ungradable ones", () => {
    const score = scoreExam(questions, [
      { selectedIndex: 1 },
      { selectedBoolean: false },
      { selfRating: "got_it" },
      { selectedIndex: 0 },
      { selectedIndex: 3 },
    ]);
    expect(score.autoTotal).toBe(3);
    expect(score.autoCorrect).toBe(2); // Q0 and the legacy letter Q4
    expect(score.selfTotal).toBe(1);
    expect(score.selfCorrect).toBe(1);
    expect(score.ungradable).toBe(1);
    expect(score.gradedTotal).toBe(4);
    expect(score.correct).toBe(3);
    expect(score.percent).toBe(75);
    expect(score.letter).toBe("C");
    expect(score.perQuestion.map((p) => p.status)).toEqual(["correct", "incorrect", "correct", "ungradable", "correct"]);
  });

  it("revealing a short answer without rating it is NOT a point (it used to auto-award one)", () => {
    const score = scoreExam([{ type: "short_answer", answer: "x" }, { type: "short_answer", answer: "y" }], [{}, { selfRating: "missed" }]);
    expect(score.correct).toBe(0);
    expect(score.percent).toBe(0);
    expect(score.unanswered).toBe(1);
  });

  it("unanswered questions count against the score but are labelled unanswered", () => {
    const score = scoreExam(questions.slice(0, 2), [{ selectedIndex: 1 }]);
    expect(score.percent).toBe(50);
    expect(score.perQuestion[1]).toEqual({ status: "unanswered", graded: "auto" });
  });

  it("accepts a sparse record as well as an array, and an empty exam gives null (not NaN)", () => {
    expect(scoreExam(questions.slice(0, 1), { 0: { selectedIndex: 1 } }).percent).toBe(100);
    const empty = scoreExam([], []);
    expect(empty.percent).toBeNull();
    expect(empty.letter).toBeNull();
    expect(scoreExam([{ type: "multiple_choice", options: [], answer: "" }], []).percent).toBeNull();
  });

  it("letter grades", () => {
    expect([100, 90, 89, 80, 70, 60, 59, 0].map(letterGrade)).toEqual(["A", "A", "B", "B", "C", "D", "F", "F"]);
  });

  it("isGradable", () => {
    expect(isGradable(mc())).toBe(true);
    expect(isGradable({ type: "multiple_choice", options: PLAIN, answer: "zzz" })).toBe(false);
  });
});
