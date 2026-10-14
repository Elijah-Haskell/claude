// The app's frame: five places (Today, Week, Tasks, Study, Classes) in a bottom tab bar on a phone and a sidebar on
// a wide screen, with the ONE add button at the end of either; the screen the hash names; the sheets that exist once
// for the whole app (Add, Replan, a task's, a session's) with the undo snackbar; and, above every route, the account
// gate: a Trajectory account is required (lib/config.ts), so without a session nothing is shown but the welcome /
// sign-in screen and the privacy policy (lib/start-route.ts), and the plan saved to the account must have settled
// before the tabs open. Every screen is a hash route (src/router.tsx), so the browser's back button and bookmarks work.

import { useEffect, type ReactNode } from "react";

import { ACCOUNT_REQUIRED } from "./lib/config";
import { subscribeSessionEnded } from "./lib/sign-in-prompt";
import { guardSendsToSignIn, startRoute, tabsGiveWayToWelcome } from "./lib/start-route";
import { useNoteEmptyAtSignIn, useSettlingGateInput } from "./state/account-gate";
import { useAuth, sessionRefused, useLeavingLine } from "./state/auth";
import { DialogHost } from "./state/dialogs";
import { useGlobalModal } from "./state/modal-context";
import { hrefFor, litTabFor, navigate, useRoute, type Route, type TabName } from "./router";
import { Icon, type IconName } from "./ui/icon";
import { useColors } from "./ui/theme";
import { AddSheet } from "./components/add-sheet";
import { BlockSheet } from "./components/block-sheet";
import { CourseFeedRefresher } from "./components/headless/course-feed-refresher";
import { GCalAutoSync } from "./components/headless/gcal-auto-sync";
import { ResumePendingExtraction } from "./components/headless/resume-pending-extraction";
import { StudyNotifications } from "./components/headless/study-notifications";
import { UndoReplanBar } from "./components/plan-status";
import { PlanSync } from "./components/plan-sync";
import { ReplanSheet } from "./components/replan-sheet";
import { TaskSheetHost } from "./components/task-sheet";
import { ActivitiesScreen } from "./screens/activities";
import { AiScreen } from "./screens/ai";
import { CalendarsScreen } from "./screens/calendars";
import { ClassesScreen } from "./screens/classes";
import { CourseFeedsScreen } from "./screens/course-feeds";
import { DeleteAccountScreen } from "./screens/delete-account";
import { ExamScreen } from "./screens/exam";
import { ExamPrepDetailScreen, ExamPrepListScreen } from "./screens/exam-prep";
import { ImportsScreen } from "./screens/imports";
import { PaywallScreen } from "./screens/paywall";
import { PracticeExamScreen, PracticeScreen } from "./screens/practice";
import { PrivacyPolicyScreen } from "./screens/privacy-policy";
import { RemindersScreen } from "./screens/reminders";
import { SemesterCalendarScreen } from "./screens/semester-calendar";
import { SettingsScreen } from "./screens/settings";
import { StudyScreen } from "./screens/study";
import { StudyGuideScreen, StudyGuidesScreen } from "./screens/study-guides";
import { SyllabusScreen } from "./screens/syllabus";
import { TasksScreen } from "./screens/tasks";
import { TestReviewScreen } from "./screens/test-review";
import { TodayScreen } from "./screens/today";
import { WeekScreen } from "./screens/week";
import { LaunchMark, WelcomeScreen } from "./screens/welcome";

/** The visible tabs, in order. Every other route (exam, activities, settings, ...) lights the tab it belongs to. */
export const MAIN_TABS: readonly { name: TabName; label: string; icon: IconName }[] = [
  { name: "today", label: "Today", icon: "today" },
  { name: "week", label: "Week", icon: "cal" },
  { name: "tasks", label: "Tasks", icon: "list" },
  { name: "study", label: "Study", icon: "cap" },
  { name: "classes", label: "Classes", icon: "book" },
];

/** Routes that open without an account session (lib/start-route.ts routeNeedsAccount). */
const OPEN_WITHOUT_ACCOUNT = new Set(["welcome", "privacy-policy"]);

function TabBar({ lit }: { lit: TabName | null }) {
  const { openAdd } = useGlobalModal();
  return (
    <nav className="tabbar" aria-label="Main">
      <div className="tabbar-tabs" role="tablist">
        {MAIN_TABS.map((tab) => {
          const on = lit === tab.name;
          return (
            <a key={tab.name} href={hrefFor(tab.name)} className={`tab${on ? " on" : ""}`} role="tab" aria-selected={on} aria-label={tab.label}>
              <span className="indicator" />
              <Icon name={tab.icon} size={23} />
              <span>{tab.label}</span>
            </a>
          );
        })}
      </div>
      <button type="button" className="add-key" aria-label="Add a task, event or exam" onClick={() => openAdd()}>
        <Icon name="plus" size={24} color="#fff" strokeWidth={2.2} />
      </button>
    </nav>
  );
}

/** Which sidebar entry a route belongs to. The phone keeps Settings under Classes; the sidebar gives it its own place. */
function sideEntryFor(name: string, lit: TabName | null): string | null {
  if (name === "ai") return "ai";
  if (["settings", "activities", "course-feeds", "calendars", "reminders", "delete-account", "privacy-policy", "paywall"].includes(name)) return "settings";
  return lit;
}

function Sidebar({ lit, routeName }: { lit: TabName | null; routeName: string }) {
  const colors = useColors();
  const { openAdd } = useGlobalModal();
  const { isAuthenticated, user } = useAuth();
  const on = sideEntryFor(routeName, lit);
  const who = user?.name && user.name !== "Trajectory Student" ? user.name : user?.email || "Your account";
  const initial = (who.trim()[0] ?? "T").toUpperCase();
  return (
    <aside className="sidebar" aria-label="Main">
      <a href={hrefFor("today")} className="brand" aria-label="Trajectory, Today">
        <span className="brand-mark">
          <Icon name="bolt" size={18} color={colors.gold} strokeWidth={2} />
        </span>
        <span className="brand-name">Trajectory</span>
      </a>
      <button type="button" className="side-add" aria-label="Add a task, event or exam" onClick={() => openAdd()}>
        <Icon name="plus" size={19} color="#fff" strokeWidth={2.2} />
        New
      </button>
      <div className="side-section">Plan</div>
      {MAIN_TABS.map((tab) => {
        const active = on === tab.name;
        return (
          <a key={tab.name} href={hrefFor(tab.name)} className={`side-tab${active ? " on" : ""}`} aria-current={active ? "page" : undefined}>
            <Icon name={tab.icon} size={20} color={active ? colors.peri : colors.muted} />
            <span>{tab.label}</span>
          </a>
        );
      })}
      <div className="side-section">Assistant</div>
      <a href={hrefFor("ai")} className={`side-tab ai${on === "ai" ? " on" : ""}`} aria-current={on === "ai" ? "page" : undefined}>
        <Icon name="spark" size={20} color={on === "ai" ? colors.violet : colors.muted} />
        <span>Ask AI</span>
      </a>
      <div className="side-foot">
        <a href={hrefFor("settings")} className={`side-tab${on === "settings" ? " on" : ""}`} aria-current={on === "settings" ? "page" : undefined}>
          <Icon name="settings" size={20} color={on === "settings" ? colors.peri : colors.muted} />
          <span>Settings</span>
        </a>
        {isAuthenticated ? (
          <a href={hrefFor("settings")} className="side-account" aria-label={`Signed in as ${who}. Your plan is saved to your account. Open Settings`}>
            <span className="side-avatar" aria-hidden="true">{initial}</span>
            <span style={{ minWidth: 0, display: "flex", flexDirection: "column" }}>
              <span className="truncate" style={{ fontSize: 13.5, fontWeight: 600 }}>{who}</span>
              <span className="truncate" style={{ fontSize: 12, color: colors.muted }}>Saved to your account</span>
            </span>
          </a>
        ) : (
          <span style={{ padding: "8px 10px 0", fontSize: 12, color: colors.dim }}>Your plan stays in this browser.</span>
        )}
      </div>
    </aside>
  );
}

function Screen({ name, segments }: { name: string; segments: string[] }) {
  switch (name) {
    case "today":
      return <TodayScreen />;
    case "week":
      return <WeekScreen />;
    case "tasks":
      return <TasksScreen />;
    case "study":
      return <StudyScreen />;
    case "classes":
      return <ClassesScreen />;
    case "exam":
      return <ExamScreen examKey={segments[0] ?? ""} />;
    case "exam-prep":
      return segments[0] ? <ExamPrepDetailScreen examId={segments[0]} /> : <ExamPrepListScreen />;
    case "activities":
      return <ActivitiesScreen />;
    case "settings":
      return <SettingsScreen />;
    case "syllabus":
      return <SyllabusScreen />;
    case "imports":
      return <ImportsScreen />;
    case "ai":
      return <AiScreen />;
    case "study-guides":
      return <StudyGuidesScreen />;
    case "study-guide":
      return segments[0] ? <StudyGuideScreen guideId={segments[0]} /> : <StudyGuidesScreen />;
    case "practice":
      return <PracticeScreen />;
    case "practice-exam":
      return segments[0] ? <PracticeExamScreen examId={segments[0]} /> : <PracticeScreen />;
    case "test-review":
      return <TestReviewScreen />;
    case "course-feeds":
      return <CourseFeedsScreen />;
    case "calendars":
      return <CalendarsScreen />;
    case "reminders":
      return <RemindersScreen />;
    case "semester-calendar":
      return <SemesterCalendarScreen />;
    case "paywall":
      return <PaywallScreen />;
    case "delete-account":
      return <DeleteAccountScreen />;
    case "privacy-policy":
      return <PrivacyPolicyScreen />;
    default:
      return <NotFound />;
  }
}

function NotFound() {
  const colors = useColors();
  return (
    <div className="screen">
      <h1 className="screen-title">Nothing here</h1>
      <p style={{ color: colors.muted }}>
        That page does not exist. <a className="link" href={hrefFor("today")}>Back to Today</a>
      </p>
    </div>
  );
}

/** The sheets that exist once for the whole app. The Ask AI page confirms its own changes with Undo, so the app-wide undo snackbar stays away while it is open. */
function GlobalSheets({ undoBar }: { undoBar: boolean }) {
  const { state, closeAdd, closeReplan, closeTask, closeBlock } = useGlobalModal();
  return (
    <>
      <AddSheet preset={state.add} onClose={closeAdd} />
      <ReplanSheet preset={state.replan} onClose={closeReplan} />
      <TaskSheetHost taskId={state.taskId} onClose={closeTask} />
      {state.blockId ? <BlockSheet blockId={state.blockId} onClose={closeBlock} /> : null}
      {undoBar ? <UndoReplanBar variant="snackbar" /> : null}
    </>
  );
}

function Frame({ lit, wide, routeName, children }: { lit: TabName | null; wide: boolean; routeName: string; children: ReactNode }) {
  return (
    <div className="app">
      <Sidebar lit={lit} routeName={routeName} />
      <main className={`app-main${wide ? " wide" : ""}`}>{children}</main>
      <TabBar lit={lit} />
    </div>
  );
}

/**
 * Universal session safety net: an UNAUTHORIZED answer to any server call that carried this browser's session means
 * the session is gone (expired, or the account was deleted). The server is asked once more to be sure, then the
 * session is dropped and the guard shows the sign-in screen, which says "You've been signed out".
 */
function SessionEndedListener() {
  useEffect(() => subscribeSessionEnded((event) => void sessionRefused(event.token)), []);
  return null;
}

/** expo-router's first path segment, as lib/start-route.ts reads it: the welcome is "onboarding", the root index none. */
function firstSegmentOf(route: Route): string | undefined {
  if (route.path === "/") return undefined;
  return route.name === "welcome" ? "onboarding" : route.name;
}

/**
 * The one account gate above every route. When the session is not there on a route that needs one (signed out, the
 * account deleted, the session expired or refused, or a link opened a screen directly), this closes the open sheets and
 * replaces the route with the sign-in screen. Also noted from here: whether this browser held a plan when its account
 * signed in, which decides what the welcome screen's "Sign out" may erase.
 */
function AccountGuard({ route, blocked }: { route: Route; blocked: boolean }) {
  const { closeAdd, closeReplan, closeTask, closeBlock } = useGlobalModal();
  useNoteEmptyAtSignIn();
  useEffect(() => {
    if (!blocked) return;
    closeAdd();
    closeReplan();
    closeTask();
    closeBlock();
    navigate("welcome", { replace: true });
  }, [blocked, route.path, closeAdd, closeReplan, closeTask, closeBlock]);
  return null;
}

/** Covers the whole app while signing out or deleting the account is under way: the emptied screens underneath must be neither seen nor used. */
function LeavingOverlay() {
  const line = useLeavingLine();
  const colors = useColors();
  if (!line) return null;
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 1000, background: colors.background }} aria-live="polite" role="status">
      <LaunchMark line={line} />
    </div>
  );
}

export function App() {
  const route = useRoute();
  const gate = useSettlingGateInput();
  const openWithoutAccount = OPEN_WITHOUT_ACCOUNT.has(route.name);
  const atRoot = route.path === "/";
  const blocked = guardSendsToSignIn({ accountRequired: ACCOUNT_REQUIRED, account: gate.account, firstSegment: firstSegmentOf(route) });

  // The root index: where to open (lib/start-route.ts decides; "loading" waits on the launch mark).
  const where = atRoot ? startRoute(gate) : null;
  useEffect(() => {
    if (!where || where === "loading") return;
    navigate(where === "/onboarding" ? "welcome" : "today", { replace: true });
  }, [where]);

  // The tabs need an account whose plan is settled, and a finished welcome screen. When that stops being true while
  // they are open (the saved plan needs a decision, the plan was reset), the welcome screen takes over.
  const giveWay = !atRoot && !openWithoutAccount && tabsGiveWayToWelcome(gate);
  useEffect(() => {
    if (giveWay) navigate("welcome", { replace: true });
  }, [giveWay, route.path]);

  // Each screen starts at the top (the hash changes, the document does not).
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [route.path]);

  const headless = (
    <>
      <PlanSync />
      <SessionEndedListener />
      <AccountGuard route={route} blocked={blocked} />
      <CourseFeedRefresher />
      <GCalAutoSync />
      <StudyNotifications />
      <ResumePendingExtraction />
      <DialogHost />
      <LeavingOverlay />
    </>
  );

  if (route.name === "welcome") {
    return (
      <>
        <WelcomeScreen />
        {headless}
      </>
    );
  }
  if (atRoot || blocked || giveWay || (ACCOUNT_REQUIRED && !openWithoutAccount && gate.account === "loading")) {
    return (
      <>
        <LaunchMark />
        {headless}
      </>
    );
  }

  const lit = litTabFor(route.name);
  return (
    <>
      <Frame lit={lit} routeName={route.name} wide={route.name === "week" || route.name === "semester-calendar"}>
        <Screen name={route.name} segments={route.segments} />
      </Frame>
      <GlobalSheets undoBar={route.name !== "ai"} />
      {headless}
    </>
  );
}
