// Trajectory — AI Study Recommendations Engine
// ============================================================
// Generates personalized study recommendations based on
// task completion, grades, schedule adherence, and workload.

import {
  AppState,
  Grade,
  StudyRecommendation,
  Task,
  ScheduleBlock,
} from "./types";
import { addDaysToKey, dateKeyOf, daysBetweenKeys, formatTime, generateId, localDateKey, minutesToTime, timeToMinutes } from "./utils";
import { dueLabel } from "./plan-format";
import { remainingMinutes } from "./task-progress";

const GPA_MAP: Record<string, number> = {
  "A": 4.0, "A-": 3.7, "B+": 3.3, "B": 3.0, "B-": 2.7,
  "C+": 2.3, "C": 2.0, "C-": 1.7, "D+": 1.3, "D": 1.0, "F": 0.0,
};

/** Work the student still has to do ("scheduled" = partly done, still open). */
const isOpen = (task: Task) => task.status === "pending" || task.status === "scheduled";

// ── Recommendation Generators ────────────────────────────────

// Overdue work is NOT a recommendation here (1.0.9): Today's plan status card (lib/plan-alerts.ts) is the one place that
// says what is overdue or behind, with Catch up and a fix per item; the Semester tab used to repeat it.

function checkAtRiskClasses(grades: Grade[], tasks: Task[]): StudyRecommendation | null {
  const lowGrades = grades.filter((g) => (GPA_MAP[g.letterGrade] || 0) < 2.5);
  if (lowGrades.length === 0) return null;

  const classIds = lowGrades.map((g) => g.classId);
  const pendingForAtRisk = tasks.filter(
    (t) => t.status === "pending" && classIds.includes(t.courseName)
  );

  return {
    id: generateId(),
    type: "at_risk",
    title: `${lowGrades.length} Class${lowGrades.length > 1 ? "es" : ""} at Risk`,
    description: `You have grades below C+ in ${lowGrades.length} class${lowGrades.length > 1 ? "es" : ""}. Focus extra study time on these subjects.`,
    actionItems: [
      "Allocate 30% more study time to at-risk classes",
      "Visit office hours or tutoring centers",
      "Form or join a study group for these subjects",
      "Review past assignments and exams for patterns",
    ],
    urgency: "high",
    createdAt: new Date().toISOString(),
  };
}

/**
 * The least study per day that still meets every deadline: for each due date, the open work due by then divided by
 * the days left until it (today included), and the highest of those. (Dividing ALL open work by the days to the
 * earliest deadline told a student with a fresh semester import they needed 30 hours a day.)
 */
function checkWorkloadBalance(tasks: Task[], now: Date): StudyRecommendation | null {
  const todayKey = localDateKey(now);
  const open = tasks
    .filter((t) => isOpen(t) && remainingMinutes(t) > 0 && dateKeyOf(t.dueDate) >= todayKey)
    .sort((a, b) => dateKeyOf(a.dueDate).localeCompare(dateKeyOf(b.dueDate)));
  if (open.length < 5) return null;

  let dueMinutes = 0;
  let peak = { hoursPerDay: 0, hours: 0, count: 0, dueKey: todayKey };
  open.forEach((task, index) => {
    dueMinutes += remainingMinutes(task);
    const dueKey = dateKeyOf(task.dueDate);
    if (index + 1 < open.length && dateKeyOf(open[index + 1]!.dueDate) === dueKey) return; // same day: add them all first
    const hoursPerDay = dueMinutes / 60 / (daysBetweenKeys(todayKey, dueKey) + 1);
    if (hoursPerDay > peak.hoursPerDay) peak = { hoursPerDay, hours: dueMinutes / 60, count: index + 1, dueKey };
  });
  const by = peak.dueKey === todayKey ? "due today" : `due by ${dueLabel(peak.dueKey, todayKey)}`;

  if (peak.hoursPerDay > 6) {
    return {
      id: generateId(),
      type: "high_priority",
      title: "Heavy Workload Detected",
      description: `${peak.hours.toFixed(1)} hours of work across ${peak.count} task${peak.count === 1 ? "" : "s"} ${peak.count === 1 ? "is" : "are"} ${by}. That's about ${peak.hoursPerDay.toFixed(1)} hours of study a day until then.`,
      actionItems: [
        "Start with what's due first",
        "If a day is too full, use Replan on Today",
        "Break large tasks into smaller, manageable chunks",
        "Eliminate non-essential activities temporarily",
      ],
      urgency: "high",
      createdAt: now.toISOString(),
    };
  }

  if (peak.hoursPerDay > 4) {
    return {
      id: generateId(),
      type: "optimization",
      title: "Moderate Workload",
      description: `${peak.hours.toFixed(1)} hours of work ${peak.count === 1 ? "is" : "are"} ${by}. Stay consistent with about ${peak.hoursPerDay.toFixed(1)} hours of study a day to stay on track.`,
      actionItems: [
        "Stick to your planned study sessions",
        "Work in focused 25-50 minute sessions",
        "Take regular breaks to maintain productivity",
      ],
      urgency: "medium",
      createdAt: now.toISOString(),
    };
  }

  return null;
}

/** Follow-through is judged on the study sessions of the last two weeks that have already ended... */
const FOLLOW_THROUGH_DAYS = 14;
/** ...and only once there are enough of them, on enough different days, to mean something. */
const MIN_ENDED_SESSIONS = 6;
const MIN_ENDED_DAYS = 3;

function checkCompletionStreak(blocks: ScheduleBlock[], now: Date): StudyRecommendation | null {
  const todayKey = localDateKey(now);
  const nowHHMM = minutesToTime(now.getHours() * 60 + now.getMinutes());
  const since = addDaysToKey(todayKey, -FOLLOW_THROUGH_DAYS);
  // Only a session that has ended can have been done or not (future sessions used to count as "not completed", so
  // every new user read "Only 0% completed"). A session the student moved to another day was not missed.
  const ended = blocks.filter((b) =>
    b.type === "study" && !b.deferredDay && b.date >= since &&
    (b.date < todayKey || (b.date === todayKey && b.endTime <= nowHHMM)));
  const days = new Set(ended.map((b) => b.date)).size;
  if (ended.length < MIN_ENDED_SESSIONS || days < MIN_ENDED_DAYS) return null;

  const done = ended.filter((b) => b.completionStatus === "done").length;
  const completionRate = done / ended.length;

  if (completionRate >= 0.8) {
    return {
      id: generateId(),
      type: "optimization",
      title: "Great Momentum!",
      description: `You finished ${done} of your last ${ended.length} study sessions. Keep it up!`,
      actionItems: [
        "Maintain your current routine",
        "Consider adding a challenging task to push yourself",
        "Reward yourself for consistency",
      ],
      urgency: "low",
      createdAt: now.toISOString(),
    };
  }

  if (completionRate < 0.4) {
    return {
      id: generateId(),
      type: "recovery",
      title: "Study Sessions Slipping",
      description: `You finished ${done} of the ${ended.length} study sessions planned in the last two weeks. If the plan asks too much, make it lighter.`,
      actionItems: [
        "Use Catch up on Today to replan around what's left",
        "Use shorter study sessions (25-30 min)",
        "Mark sessions done when you finish them, so this stays accurate",
      ],
      urgency: "medium",
      createdAt: now.toISOString(),
    };
  }

  return null;
}

function checkSleepOptimization(state: AppState): StudyRecommendation | null {
  const { bedtime, wakeTime, sleepTargetHours } = state.healthPrefs;
  const bedMin = timeToMinutes(bedtime);
  const wakeMin = timeToMinutes(wakeTime);

  let actualSleep = wakeMin - bedMin;
  if (actualSleep < 0) actualSleep += 24 * 60;
  const actualHours = actualSleep / 60;

  if (actualHours < sleepTargetHours - 1) {
    return {
      id: generateId(),
      type: "recovery",
      title: "Sleep Deficit",
      description: `Your schedule allows ${actualHours.toFixed(1)} hours of sleep, but your target is ${sleepTargetHours} hours. Sleep deprivation reduces academic performance.`,
      actionItems: [
        `Move your bedtime earlier to ${clockTime(bedMin - (sleepTargetHours - actualHours) * 60)}`,
        "Avoid screens 30 minutes before bed",
        "Change your sleep window on the Classes tab: study is never planned inside it",
      ],
      urgency: "medium",
      createdAt: new Date().toISOString(),
    };
  }

  return null;
}

function checkUpcomingDeadlines(tasks: Task[], now: Date): StudyRecommendation | null {
  const todayKey = localDateKey(now);
  const lastUrgentKey = addDaysToKey(todayKey, 2);
  const urgent = tasks.filter(
    (t) =>
      isOpen(t) &&
      dateKeyOf(t.dueDate) >= todayKey &&
      dateKeyOf(t.dueDate) <= lastUrgentKey
  );

  if (urgent.length === 0) return null;

  return {
    id: generateId(),
    type: "high_priority",
    title: `${urgent.length} Task${urgent.length > 1 ? "s" : ""} Due Soon`,
    description: `${urgent.length} task${urgent.length > 1 ? "s" : ""} due within 48 hours: ${urgent.map((t) => t.name).join(", ")}`,
    actionItems: [
      "Focus on these tasks first today",
      "If today is too full, use Replan on Today",
      "Break tasks into 25-minute focused sessions",
    ],
    urgency: "high",
    createdAt: now.toISOString(),
  };
}

/** Minutes since midnight (any value, wrapped into the day) as "10:30 PM". */
function clockTime(minutes: number): string {
  const m = ((Math.round(minutes) % (24 * 60)) + 24 * 60) % (24 * 60);
  return formatTime(minutesToTime(m));
}

// ── Main Generator ───────────────────────────────────────────

/** Recommendations for the Semester tab, most urgent first. `now` is injectable for tests. */
export function generateRecommendations(state: AppState, now: Date = new Date()): StudyRecommendation[] {
  const recommendations: StudyRecommendation[] = [];

  const checks = [
    checkUpcomingDeadlines(state.tasks, now),
    checkAtRiskClasses(state.grades || [], state.tasks),
    checkWorkloadBalance(state.tasks, now),
    checkCompletionStreak(state.scheduleBlocks, now),
    checkSleepOptimization(state),
  ];

  for (const rec of checks) {
    if (rec) recommendations.push(rec);
  }

  // Sort by urgency: high > medium > low
  const urgencyOrder: Record<string, number> = { high: 0, medium: 1, low: 2 };
  recommendations.sort(
    (a, b) => (urgencyOrder[a.urgency] ?? 1) - (urgencyOrder[b.urgency] ?? 1)
  );

  return recommendations;
}
