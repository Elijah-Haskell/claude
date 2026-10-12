// The app's frame: five places (Today, Week, Tasks, Study, Classes) in a bottom tab bar on a phone and a sidebar on
// a wide screen, with the ONE add button at the end of either; the screen the hash names; and the sheets that exist
// once for the whole app (Add, Replan, a task's, a session's) with the undo snackbar. Every screen is a hash route
// (src/router.tsx), so the browser's back button and bookmarks work.

import { useEffect, type ReactNode } from "react";

import { useApp } from "./state/app-provider";
import { PREF_KEYS, readPref } from "./state/local-prefs";
import { useGlobalModal } from "./state/modal-context";
import { hrefFor, litTabFor, navigate, useRoute, type TabName } from "./router";
import { Icon, type IconName } from "./ui/icon";
import { useColors } from "./ui/theme";
import { AddSheet } from "./components/add-sheet";
import { BlockSheet } from "./components/block-sheet";
import { UndoReplanBar } from "./components/plan-status";
import { ReplanSheet } from "./components/replan-sheet";
import { TaskSheetHost } from "./components/task-sheet";
import { ActivitiesScreen } from "./screens/activities";
import { ClassesScreen } from "./screens/classes";
import { ExamScreen } from "./screens/exam";
import { ExamPrepDetailScreen, ExamPrepListScreen } from "./screens/exam-prep";
import { ImportsScreen } from "./screens/imports";
import { SettingsScreen } from "./screens/settings";
import { StudyScreen } from "./screens/study";
import { SyllabusScreen } from "./screens/syllabus";
import { TasksScreen } from "./screens/tasks";
import { TodayScreen } from "./screens/today";
import { WeekScreen } from "./screens/week";
import { WelcomeScreen } from "./screens/welcome";

/** The visible tabs, in order. Every other route (exam, activities, settings, ...) lights the tab it belongs to. */
export const MAIN_TABS: readonly { name: TabName; label: string; icon: IconName }[] = [
  { name: "today", label: "Today", icon: "today" },
  { name: "week", label: "Week", icon: "cal" },
  { name: "tasks", label: "Tasks", icon: "list" },
  { name: "study", label: "Study", icon: "cap" },
  { name: "classes", label: "Classes", icon: "book" },
];

function TabBar({ lit }: { lit: TabName | null }) {
  const { openAdd } = useGlobalModal();
  return (
    <nav className="tabbar" aria-label="Main">
      <div className="tabbar-tabs" role="tablist">
        {MAIN_TABS.map((tab) => {
          const on = lit === tab.name;
          return (
            <a key={tab.name} href={hrefFor(tab.name)} className={`tab${on ? " on" : ""}`} role="tab" aria-selected={on} aria-label={tab.label}>
              {/* Colour is not the only cue for the open tab: a short line sits above its icon. */}
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

function Sidebar({ lit }: { lit: TabName | null }) {
  const colors = useColors();
  const { openAdd } = useGlobalModal();
  return (
    <aside className="sidebar" aria-label="Main">
      <a href={hrefFor("today")} className="brand" aria-label="Trajectory, Today">
        <span className="brand-mark">
          <Icon name="bolt" size={18} color={colors.gold} strokeWidth={2} />
        </span>
        <span className="brand-name">TRAJECTORY</span>
      </a>
      {MAIN_TABS.map((tab) => {
        const on = lit === tab.name;
        return (
          <a key={tab.name} href={hrefFor(tab.name)} className={`side-tab${on ? " on" : ""}`} aria-current={on ? "page" : undefined}>
            <Icon name={tab.icon} size={21} color={on ? colors.peri : colors.muted} />
            <span>{tab.label}</span>
          </a>
        );
      })}
      <button type="button" className="side-add" aria-label="Add a task, event or exam" onClick={() => openAdd()}>
        <Icon name="plus" size={20} color="#fff" strokeWidth={2.2} />
        Add
      </button>
      <div className="side-foot">Your plan stays in this browser.</div>
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
    case "welcome":
      return <WelcomeScreen />;
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

/** The sheets that exist once for the whole app. */
function GlobalSheets() {
  const { state, closeAdd, closeReplan, closeTask, closeBlock } = useGlobalModal();
  return (
    <>
      <AddSheet preset={state.add} onClose={closeAdd} />
      <ReplanSheet preset={state.replan} onClose={closeReplan} />
      <TaskSheetHost taskId={state.taskId} onClose={closeTask} />
      {state.blockId ? <BlockSheet blockId={state.blockId} onClose={closeBlock} /> : null}
      <UndoReplanBar variant="snackbar" />
    </>
  );
}

function Frame({ lit, wide, children }: { lit: TabName | null; wide: boolean; children: ReactNode }) {
  return (
    <div className="app">
      <Sidebar lit={lit} />
      <main className={`app-main${wide ? " wide" : ""}`}>{children}</main>
      <TabBar lit={lit} />
    </div>
  );
}

export function App() {
  const route = useRoute();
  const { state, isHydrated } = useApp();

  // A first visit (no plan saved, welcome not seen) opens on the welcome page.
  useEffect(() => {
    if (!isHydrated || route.name === "welcome") return;
    const fresh = state.classes.length === 0 && state.tasks.length === 0 && !state.semester && !readPref(PREF_KEYS.welcomeSeen);
    if (fresh && window.location.hash.replace(/^#\/?/, "") === "") navigate("welcome", { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isHydrated]);

  // Each screen starts at the top (the hash changes, the document does not).
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [route.path]);

  if (route.name === "welcome") {
    return <WelcomeScreen />;
  }

  const lit = litTabFor(route.name);
  return (
    <>
      <Frame lit={lit} wide={route.name === "week"}>
        <Screen name={route.name} segments={route.segments} />
      </Frame>
      <GlobalSheets />
    </>
  );
}
