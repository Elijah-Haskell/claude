# Trajectory for the web

A browser version of Trajectory, the student planner: add your classes and deadlines (or paste a syllabus) and it
plans your study time around your classes, work, activities and sleep, re-plans by itself when something changes,
and lets you undo any change. Everything stays in your browser: there is no account and no server.

## What is here

- **Today**: the day in order (classes, study sessions with a tick box, commitments), one deadline card, a "Heads
  up" tile with the plan status, today's workload and the fixes for each, and the one **Replan** sheet (today, this
  week or the semester, always previewed first, always undoable).
- **Week**: the plan on a calendar, three days or seven days wide, or as a month, with a "due" row in gold.
- **Tasks**: everything with a due date, by date or by class; a task's sheet previews what moves before you save.
- **Study**: the next exam, the ones after it, quizzes and what is over; **Exam prep** with topics, mastery,
  flashcards and a self-marked quiz, and study time planned by the same planner as everything else.
- **Classes**: your classes, the term's dates and breaks, imported syllabi, work and activities, and **Settings**
  (sleep hours, study load, calendar export, backup and restore, appearance, an optional AI key).
- **Syllabus import** in four steps: paste the text (or pick a .txt file) → check the class → check the dates →
  the plan is built. A built-in reader finds dated items line by line; with your own Gemini API key, Gemini
  reads the whole document instead (the same models and request shape as the mobile app's server). Either way the dates are resolved deterministically by the planning engine,
  and the import can be undone from Today or from the import history.

The planning engine (`src/engine/`) is the mobile app's pure TypeScript, ported file for file, with its original
test suite (`tests/engine/`). The screens in `src/screens/` and `src/components/` are a web rebuild of the mobile
screens on the same design system (`src/styles.css`, `src/ui/`).

## Run it

```bash
npm install
npm run dev        # http://localhost:5173
```

```bash
npm run check      # type-check
npm test           # engine tests + web unit tests (vitest)
npm run build      # production build into dist/
npm run preview    # serve dist/ at http://localhost:4173
node tests/smoke.mjs   # browser smoke test against the preview (needs playwright + Chromium)
```

`dist/` is a static site: host it anywhere. For a sub-path, build with `VITE_BASE=/trajectory/ npm run build`.

## The optional AI reader

Settings → "AI syllabus reader" takes a Gemini API key (Google AI Studio). It is stored in this browser's
localStorage only and sent straight to Google's `generateContent` endpoint from the page, never to any Trajectory
server. It is used for two things: reading a pasted syllabus (JSON output against the engine's own schema, then
validated by the engine's parser) and writing an exam prep's study material. The request shape mirrors the mobile
app's server: `gemini-3.8-flash` by default, `responseJsonSchema` structured output and a Gemini 3 thinking level
with headroom for the answer. Without a key, everything still works: the built-in reader handles syllabi and the
exam prep uses what your own notes give it.

## Where your plan lives

`localStorage` under `trajectory_app_state_v1` (the same shape the mobile app saves), with the undo snapshot and a
few preferences beside it. Settings → "Back up this plan" saves it as a JSON file, "Restore a backup" loads one.
"Calendar file" exports every class, session and deadline as an `.ics` file for Google, Apple or Outlook.
