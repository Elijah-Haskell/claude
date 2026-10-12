// ============================================================
// Which assistant endpoint a message goes to (pure)
// ============================================================
// A message that asks to change something already on the calendar goes to the edit endpoint (it returns block
// edits the student reviews); everything else is a conversation that may add tasks/events or propose an edit
// itself. Seen on the phone 2026-09-24: "you said you moved quiz 9 and homework 3 but they didn't get moved"
// matched no verb ("moved") and no target ("quiz"), so the conversational model "moved" things by inventing
// duplicate events.

const CHANGE_VERB = /\b(chang(e|ed|ing)|mov(e|ed|ing)|reschedul(e|ed|ing)|shift(ed|ing)?|updat(e|ed|ing)|edit(ed|ing)?|modif(y|ied|ying)|push(ed|ing)?|pull(ed|ing)?|delay(ed|ing)?|bump(ed)?|swap(ped)?|switch(ed)?|earlier|later|sooner|back|forward|instead)\b/;
const CALENDAR_TARGET = /\b(lunch|breakfast|dinner|meal|snack|workout|gym|class|meeting|appointment|event|block|session|time|slot|schedule|wake|bedtime|sleep|study|review|practice|prep|quiz|quizzes|homework|hw|exam|midterm|final|assignment|paper|essay|project|task|reading|lab)\b/;
const CORRECTION = /\b(fix it|that('s| is) wrong|undo that|revert|that was wrong|no,? (it|that)|wrong (time|direction|day)|actually|didn'?t (get )?(move|change)|did not (get )?(move|change)|still (there|the same)|nothing (changed|moved|happened))\b/;

// A deadline that itself moved ("Midterm moved to Tuesday", "the essay is now due Friday") is news about a TASK,
// not a request to move a calendar block: it goes to the conversation, which proposes a new due date ("deadline")
// and the app re-plans every session around it. Moving a study session for it ("move my midterm review") stays
// an edit.
const DEADLINE_SUBJECT = /\b(exam|midterm|final|quiz|quizzes|test|assignment|essay|paper|project|homework|hw|lab|presentation|problem set|pset|deadline)\b/;
const SESSION_WORD = /\b(review|session|sessions|prep|study|studying|practice|block|slot)\b/;
const DEADLINE_WORD = /\b(due|deadline|extended|extension|postponed)\b/;
const MOVED_VERB = /\b(moved|pushed|postponed|rescheduled|changed|delayed|bumped|extended|shifted|is now|now on|got moved)\b/;
const IMPERATIVE_START = /^\s*(please\s+|can you\s+|could you\s+)?(move|push|reschedule|shift|change|put|swap|switch|bump|delay|pull)\b/;
const INSTRUCTOR = /\b(professor|prof|teacher|instructor|ta|lecturer)\b/;

/** True when the message says an exam / assignment deadline itself moved (see above). */
export function isDeadlineChangeIntent(text: string): boolean {
  const lower = text.toLowerCase();
  if (!DEADLINE_SUBJECT.test(lower) || SESSION_WORD.test(lower)) return false;
  if (DEADLINE_WORD.test(lower)) return true;
  if (INSTRUCTOR.test(lower) && MOVED_VERB.test(lower)) return true;
  // "Midterm moved to Tuesday": the assessment comes BEFORE the verb (it is the subject, not the object).
  const subject = DEADLINE_SUBJECT.exec(lower);
  const verb = MOVED_VERB.exec(lower);
  return Boolean(subject && verb && subject.index < verb.index && !IMPERATIVE_START.test(lower));
}

/** True when the message asks to change, move or correct something that is already on the calendar. */
export function isEditIntent(text: string): boolean {
  const lower = text.toLowerCase();
  if (isDeadlineChangeIntent(lower)) return false;
  return (CHANGE_VERB.test(lower) && CALENDAR_TARGET.test(lower)) || CORRECTION.test(lower);
}
