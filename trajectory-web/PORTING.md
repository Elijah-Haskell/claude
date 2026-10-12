# Porting notes for the web (for the parallel screen ports)

The web app lives in `trajectory-web/` and is a separate project from the mobile app at `/home/user/trajectory-app`,
which is READ-ONLY reference. Never modify, commit to or push the mobile repo.

## What exists

- `src/engine/` — the mobile app's `lib/*.ts` pure modules, ported file for file (same names). Import engine modules
  from `../engine/<name>` (e.g. `../engine/types`, `../engine/utils`, `../engine/study-parsers`).
- `src/shared/` — the mobile `shared/*` (pro, term-pass, plan-sync, live-import, const).
- `src/lib/api.ts` — the server. `query("plan.header")`, `mutate("ai.conversationalChat", input)`. Procedure names,
  inputs and outputs are typed in the `Procedures` interface; add or narrow types there when you need them (the
  study tools' outputs are `unknown` until their port narrows them). Errors are `ApiError` (`code`, `httpStatus`,
  `appCode` for Pro refusals); `errorMessage(error)` gives the sentence to show. A FORBIDDEN Pro refusal already
  opens the paywall prompt by itself; an UNAUTHORIZED answer already ends the session by itself. `ai.*` calls ask
  for AI consent by themselves (src/state/ai-consent.tsx).
- `src/state/auth.tsx` — `useAuth()` → `{ user, loading, isAuthenticated, logout }`.
- `src/state/subscription-context.tsx` — `useProStatus()` → `{ isPro, isLoading }`, `useProDetails()`, `useSubscription()`.
- `src/state/use-pro-gate.ts` — `useProGate()` returns `requirePro(): boolean` (opens `#/paywall` for free users;
  false without opening while loading); `useRedirectToPaywallIfNotPro()` for Pro-only screens.
- `src/state/dialogs.tsx` — `showAlert({ title, message, buttons })`, `confirmDialog(...)`, `tellDialog(...)` (web
  stand-ins for Alert.alert). Never use `window.alert`/`confirm`.
- `src/state/app-provider.tsx` — `useApp()` → `{ state, dispatch, isHydrated, runReplan, flush }`.
- `src/state/modal-context.tsx` — `useGlobalModal()` → `openAdd`, `openReplan`, `openTask(taskId)`, `openBlock(id)`.
- `src/state/local-prefs.ts` — `useLocalPref(key)`, `PREF_KEYS` (small per-browser preferences).
- `src/lib/storage.ts` — `appStorage` (async localStorage), `readLocal/writeLocal` (sync).
- `src/router.tsx` — `navigate(path, { replace })`, `goBack(fallback)`, `useRoute()` → `{ name, segments, query }`.
  Routes are hash routes: `#/ai`, `#/study-guides`, `#/study-guide/<id>`, `#/practice`, `#/practice-exam/<id>`,
  `#/test-review`, `#/course-feeds`, `#/calendars`, `#/reminders`, `#/semester-calendar`, `#/paywall`,
  `#/privacy-policy`, `#/syllabus`, `#/imports`, `#/exam-prep[/<id>]`. The route table is in `src/app.tsx` and the
  placeholder screens in `src/screens/*.tsx` already export the component names it imports: replace the placeholder
  body, keep the export names, and do not edit `src/app.tsx` or `src/router.tsx`.
- `src/ui/primitives.tsx` — Card, Pill, DateBadge, SectionLabel, FieldLabel, FieldGroup, FieldRow, FieldPickRow,
  Note, Segmented, PrimaryButton, ScreenHeader, HeaderIconButton, CloseButton, CheckBox, CourseChip, ProgressRing,
  AppSwitch, Chip, Tile, TileRow, DateInput, TimeInput, Stepper, InlineConfirm, DayToggles, Swatches, MONO_FONT.
  `src/ui/sheet.tsx` — Sheet, SheetHead, SheetBody. `src/ui/icon.tsx` — Icon (names listed at its top).
  `src/ui/theme.tsx` — `useColors()` (the mobile palette: foreground, muted, dim, peri, violet, gold, success,
  error, primary, accent, surface, panel, background, border, borderStrong). CSS classes: `.screen`, `.screen-title`,
  `.row`, `.row-text`, `.row-label`, `.row-detail`, `.well`, `.group`, `.card`, `.pressable`, `.link`, `.caption`,
  `.input`, `.eyebrow`, `.mono`, `.spinner`.
- Screens are plain React + inline styles/CSS classes (no React Native). Look at `src/screens/exam-prep.tsx` and
  `src/screens/settings.tsx` for the house style. Every interactive element needs an aria-label or visible text.
- Files are read in the browser with `File`/`FileReader`; base64 for uploads: `btoa` over the bytes, or
  `FileReader.readAsDataURL` and strip the prefix. Server limits: 10 MB per file, PDF/JPEG/PNG/WebP.

## Rules

- Same behaviour and copy as the mobile screen you port, except where the platform differs (say "this browser"
  where it says "this iPhone"; no haptics, no OS permission screens, no App Store).
- Pure logic goes in `src/lib/<name>.ts` (copy the mobile `lib/<name>.ts` verbatim when it is pure, fix imports);
  React bits in `src/screens/` or `src/components/`.
- Remove nothing that exists; add tests under `tests/web/*.test.ts` (vitest) for new pure modules you port.
- `npx tsc --noEmit -p tsconfig.json` must pass; run `npx vitest run tests/web` for your tests.
- The mock API for browser tests is `tests/mock-server.mjs` (real tRPC, superjson). Extend it if your screen needs a
  procedure it lacks, keeping the real server's names and shapes.
