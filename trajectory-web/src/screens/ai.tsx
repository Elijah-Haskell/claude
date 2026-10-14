/**
 * Trajectory AI — the page the "Ask AI" button on Today and Week opens (it is not a tab; no tab is lit on it).
 *
 * One box: tell Trajectory what changed, or what to add. The assistant only PROPOSES: a change to existing sessions
 * or deadlines comes back as a list of "old → new" to review, new assignments, events and weekly commitments come back
 * as a list to check (click a task to correct it), and nothing touches the plan until the student has seen exactly
 * what would move (ReplanPreviewBody) and applied it, as one undoable change.
 *
 * It is part of Trajectory Pro. Without Pro the same page shows a PRO tag: sending a message or picking an example
 * opens the paywall (nothing is sent), and under the examples are two free ways to change the plan: "Replan today"
 * (the same Replan sheet Today opens) and "Add a task" (the Add sheet).
 *
 * Route contract: `#/ai?prompt=...` sends that text (without Pro it only fills the box).
 * The mobile app's app/(tabs)/ai.tsx, written for the DOM.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { describeReplanDiff } from "../engine/app-context";
import { isEmptyChange, previewAssistantChange, type AssistantChange, type BlockEdit, type RecurringEdit } from "../engine/assistant-change";
import { alpha } from "../engine/design";
import { undoableChange } from "../engine/replan";
import type { ClassBlock, RecurringEvent, ScheduleBlock, Task } from "../engine/types";
import { addDaysToKey, formatTime, toDateString } from "../engine/utils";
import { blockDisplayTitle, showsOnWeekGrid } from "../engine/week-layout";
import { AiContentLabel } from "../components/ai-content-label";
import { aiInk, ChangeRow, Composer, DockHint, ExampleList, ItemRow, MessageRow, ParsedTaskCard, ReviewDock, ReviewList, Spinner, ThinkingRow } from "../components/ai/chat-parts";
import { ReplanPreviewBody } from "../components/replan-preview";
import {
  DONE_PREFIX,
  addedConfirmation,
  parsedItemsText,
  pendingEditHeadline,
  pendingEditRows,
  planChangeText,
  taskFromParsed,
  type ChatMessage,
  type ParsedEvent,
  type ParsedNewClass,
  type ParsedRecurringEvent,
  type ParsedTask,
  type PendingEdit,
} from "../lib/ai-items";
import { buildMemoryContext, learnFromEvents, learnFromTasks, loadAIMemory, type AIMemory } from "../lib/ai-memory";
import { mutate } from "../lib/api";
import { isDeadlineChangeIntent, isEditIntent } from "../lib/assistant-intent";
import { displayableReply } from "../lib/assistant-reply";
import { goBack, navigate, useRoute } from "../router";
import { useApp } from "../state/app-provider";
import { useGlobalModal } from "../state/modal-context";
import { useProStatus } from "../state/subscription-context";
import { useReplanFlow } from "../state/use-replan-flow";
import { Icon, type IconName } from "../ui/icon";
import { HeaderIconButton, MONO_FONT, PrimaryButton, SectionLabel } from "../ui/primitives";
import { Sheet } from "../ui/sheet";
import { useColors } from "../ui/theme";
import { useDesktop } from "../ui/layout";

// ── Helpers ───────────────────────────────────────────────────

function todayString(): string {
  return toDateString(new Date());
}

/** Meal/workout blocks no longer exist; if the model still returns those event types, keep them as plain events. */
function blockTypeForEvent(type: ParsedEvent["type"]): "free" | "work" | "recurring" | "buffer" {
  return type === "meal" || type === "workout" ? "free" : type;
}

/** The example lines on the page before anything is said: a click puts one in the box. */
const EXAMPLE_PROMPTS = [
  "My midterm moved to Tuesday",
  "Move all my reading to mornings",
  "I picked up a Friday shift",
  "I'm sick today, push everything",
] as const;

const LEDE = "Tell Trajectory what changed. You review every change before it's applied.";
const FOOTNOTE = "Assignments, exams, events and weekly commitments work too. They get planned across your whole semester.";
const PLACEHOLDER = "Say what changed";

/** Without Pro: what picking an example or Send does instead of sending. */
const PRO_HINT = "Part of Trajectory Pro. Opens the plans";

const EVENT_COLORS: Record<string, string> = {
  free: "#7C3AED",
  work: "#3B82F6",
  recurring: "#8B5CF6",
  buffer: "#6B7280",
};

const capitalized = (words: string) => (words ? words[0]!.toUpperCase() + words.slice(1) : words);

/** A change that was just applied: what it did in words ("3 sessions moved", or ""), and the plan it left. */
interface Applied {
  what: string;
  blocks: ScheduleBlock[];
}

// ── Main Screen ───────────────────────────────────────────────

export function AiScreen() {
  const colors = useColors();
  const desktop = useDesktop();
  const route = useRoute();
  const { state, dispatch } = useApp();
  const { isPro, isLoading: isProLoading } = useProStatus();
  // Without Pro, the two free ways to change the plan: the Replan sheet the app renders (Today opens it too) and the
  // Add sheet.
  const { openReplan, openAdd } = useGlobalModal();
  // Every message goes to an ai.* procedure, under the account's session (lib/api.ts).
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: "welcome",
      role: "assistant",
      content:
        "Hey! 👋 I help you plan your whole semester — not just this week.\n\nTell me about assignments, exams, events, or recurring commitments and I'll schedule them across your semester automatically.\n\nTry things like:\n• \"Chem problem set due next Thursday, 2 hours\"\n• \"Midterm on April 15, need 3 study sessions\"\n• \"I have work every weekday 9-5\"\n• \"Move my Wednesday study block to 7pm\"",
    },
  ]);
  const [inputText, setInputText] = useState("");
  const [parsedTasks, setParsedTasks] = useState<ParsedTask[]>([]);
  const [parsedEvents, setParsedEvents] = useState<ParsedEvent[]>([]);
  const [parsedRecurringEvents, setParsedRecurringEvents] = useState<ParsedRecurringEvent[]>([]);
  const [parsedNewClasses, setParsedNewClasses] = useState<ParsedNewClass[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  // Last applied edit — stored so corrections ("fix it", "that's wrong") can reference what changed
  const lastEditRef = useRef<{
    summary: string;
    editBlocks: Record<string, unknown>[];
    editRecurring: Record<string, unknown>[];
    newEvents: ParsedEvent[];
    newRecurring: ParsedRecurringEvent[];
    healthPrefsUpdate?: { mealTimes?: string[]; wakeTime?: string; bedtime?: string };
  } | null>(null);

  // Pending edit review state — stores AI edit result before user confirms
  const [pendingEdit, setPendingEdit] = useState<PendingEdit | null>(null);

  const [aiMemory, setAiMemory] = useState<AIMemory | null>(null);

  // Load AI memory on mount
  useEffect(() => {
    loadAIMemory().then(setAiMemory).catch(() => {});
  }, []);

  // Pending deep-link prompt — will be auto-sent after handleSend is defined (the router already decoded it).
  const promptParam = route.query.prompt;
  const pendingPromptRef = useRef<string | null>(null);
  if (typeof promptParam === "string" && promptParam.trim() && !pendingPromptRef.current) {
    pendingPromptRef.current = promptParam.trim();
  }

  const classOptions = state.classes.map((c) => ({ id: c.id, name: c.name }));

  const conversationHistory = messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  const scrollToBottom = useCallback(() => {
    setTimeout(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "smooth" }), 100);
  }, []);

  // Resolve which dates the user is referring to in a message ("today", "tomorrow", "Monday", etc.)
  function resolveTargetDates(text: string): string[] {
    const lower = text.toLowerCase();
    const todayDate = todayString();
    const todayObj = new Date(todayDate + "T12:00:00");
    const DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
    const results: string[] = [];

    // "today" or no day keyword
    if (/\btoday\b/.test(lower)) {
      results.push(todayDate);
    }
    // "tomorrow"
    if (/\btomorrow\b/.test(lower)) {
      const d = new Date(todayObj);
      d.setDate(d.getDate() + 1);
      results.push(toDateString(d));
    }
    // "this week" or "this weekend"
    if (/\bthis week\b|\bthis weekend\b/.test(lower)) {
      for (let i = 0; i < 7; i++) {
        const d = new Date(todayObj);
        d.setDate(d.getDate() + i);
        results.push(toDateString(d));
      }
    }
    // Named days: "Monday", "on Tuesday", etc.
    DAY_NAMES.forEach((dayName, dayIdx) => {
      if (new RegExp(`\\b${dayName}\\b`).test(lower)) {
        const todayDow = todayObj.getDay();
        let daysAhead = dayIdx - todayDow;
        if (daysAhead <= 0) daysAhead += 7; // always next occurrence
        const d = new Date(todayObj);
        d.setDate(d.getDate() + daysAhead);
        results.push(toDateString(d));
      }
    });
    // Specific date patterns like "March 15", "3/15"
    const monthNames = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
    monthNames.forEach((m, mi) => {
      const re = new RegExp(`\\b${m}\\s+(\\d{1,2})\\b`);
      const match = lower.match(re);
      if (match) {
        const year = todayObj.getFullYear();
        const day = parseInt(match[1]!, 10);
        const d = new Date(year, mi, day);
        results.push(toDateString(d));
      }
    });

    // Default: if no day keyword found, assume today
    if (results.length === 0) results.push(todayDate);
    return [...new Set(results)];
  }

  /**
   * Blocks worth showing the assistant: not sleep or the planner's transitions (a student's own "buffer" event is
   * included, so it can be asked about and moved), within a window around today (the whole semester is too much).
   */
  function blocksAround(daysBack: number, daysAhead: number): ScheduleBlock[] {
    const today = todayString();
    const from = addDaysToKey(today, -daysBack);
    const to = addDaysToKey(today, daysAhead);
    return state.scheduleBlocks
      .filter((b) => showsOnWeekGrid(b) && b.date >= from && b.date <= to)
      .sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime))
      .slice(0, 400);
  }

  /** A proposed set of block moves (from either endpoint) goes to the review card; nothing is applied yet. */
  function proposeBlockEdits(edits: { id: string; date?: string; startTime?: string; endTime?: string; title?: string }[], reply: string) {
    const titled = edits.map((eb) => {
      const original = state.scheduleBlocks.find((b) => b.id === eb.id);
      return { ...eb, title: eb.title ?? original?.title ?? "Block", startTime: eb.startTime ?? original?.startTime, endTime: eb.endTime ?? original?.endTime };
    });
    lastEditRef.current = { summary: reply, editBlocks: titled, editRecurring: [], newEvents: [], newRecurring: [] };
    setPendingEdit({ editBlocks: titled, editRecurring: [], newEvents: [], newRecurring: [], summary: reply });
    setMessages((prev) => [
      ...prev,
      { id: `ai-${Date.now()}`, role: "assistant", content: reply },
    ]);
  }

  async function handleSend(overrideText?: string) {
    const text = (overrideText ?? inputText).trim();
    if (!text || isLoading) return;
    // Ask AI is Pro: without it nothing is sent (the free screen's Send opens the paywall itself).
    if (!isPro) return;

    const userMsg: ChatMessage = {
      id: `user-${Date.now()}`,
      role: "user",
      content: text,
    };

    setMessages((prev) => [...prev, userMsg]);
    setInputText("");
    setIsLoading(true);
    scrollToBottom();

    try {
      // If the user is asking to edit/reschedule existing events, use the editSchedule endpoint
      if (isEditIntent(text)) {
        // The block being moved is often NOT on the day the student names ("move quiz 9 to Sunday": the session sits
        // on Thursday), so the model sees the next three weeks plus the named dates, not just the named dates.
        const targetDates = resolveTargetDates(text);
        const isCorrection = /\b(fix it|that('s| is) wrong|undo that|revert|actually)\b/i.test(text);
        const nearTarget = (date: string) => targetDates.some((td) => Math.abs(new Date(td + "T12:00:00").getTime() - new Date(date + "T12:00:00").getTime()) <= 86400000);
        const windowBlocks = blocksAround(1, 21);
        const windowIds = new Set(windowBlocks.map((b) => b.id));
        const filteredBlocks = [
          ...windowBlocks,
          ...state.scheduleBlocks.filter((b) => showsOnWeekGrid(b) && !windowIds.has(b.id) && (isCorrection || nearTarget(b.date))),
        ].slice(0, 600);
        const scheduleContext = filteredBlocks
          .map((b) => ({
            id: b.id,
            title: b.title,
            date: b.date,
            startTime: b.startTime,
            endTime: b.endTime,
            type: b.type,
          }));
        const recurringContext = (state.recurringEvents || []).map((r) => ({
          id: r.id,
          title: r.title,
          days: r.days,
          startTime: r.startTime,
          endTime: r.endTime,
        }));

        // Pass the sleep window so the AI knows when the student sleeps.
        // (The edit endpoint still accepts the legacy meal fields and ignores them; they are not sent.)
        const hp = state.healthPrefs;
        const healthPrefsCtx = hp ? {
          wakeTime: hp.wakeTime,
          bedtime: hp.bedtime,
        } : undefined;

        // Build last-edit context for correction memory
        const lastEditContext = lastEditRef.current
          ? `\n## What I just changed (for corrections):\n${lastEditRef.current.summary}\nEdited blocks: ${JSON.stringify(lastEditRef.current.editBlocks.map((b) => ({ id: b.id, title: b.title, startTime: b.startTime, endTime: b.endTime })))}`
          : "";

        // Build full context for editSchedule
        const editTasksCtx = state.tasks
          .filter((t) => t.status !== "done" && t.status !== "skipped")
          .map((t) => ({ id: t.id, name: t.name, courseName: t.courseName, dueDate: t.dueDate, estimatedMinutes: t.estimatedMinutes, difficulty: t.difficulty, status: t.status }));
        const editGradesCtx = (state.grades ?? []).map((g) => ({ classId: g.classId, letterGrade: g.letterGrade, numericGrade: g.numericGrade }));
        const editMemCtx = aiMemory ? buildMemoryContext(aiMemory) : undefined;

        // Build syllabus context for editSchedule (same as conversationalChat)
        let editSyllabusCtx = "";
        const editSyllabusImports = state.syllabusImports ?? [];
        if (editSyllabusImports.length > 0) {
          const editSyllabusLines: string[] = ["\n## Uploaded Syllabi:"];
          editSyllabusImports.forEach((si) => {
            editSyllabusLines.push(`\n### ${si.linkedClassName} (${si.courseName})`);
            if (si.rawText && si.rawText.trim().length > 0) {
              const truncated = si.rawText.length > 8000 ? si.rawText.slice(0, 8000) + "\n[...truncated...]" : si.rawText;
              editSyllabusLines.push(`Full syllabus text:\n${truncated}`);
            }
          });
          editSyllabusCtx = editSyllabusLines.join("\n");
        }
        const editFullMemCtx = [editMemCtx, editSyllabusCtx].filter(Boolean).join("\n") || undefined;

        const editResult = await mutate("ai.editSchedule", {
          message: text + lastEditContext,
          today: todayString(),
          scheduleBlocks: scheduleContext,
          recurringEvents: recurringContext,
          healthPrefs: healthPrefsCtx,
          tasks: editTasksCtx,
          grades: editGradesCtx,
          memoryContext: editFullMemCtx,
        });

        // Edits name the block's current title (the model's answer only carries the id and the new time), and an
        // edit of a block that is not on the calendar is dropped rather than shown.
        const editBlocks = (editResult.editBlocks ?? []).flatMap((eb) => {
          const id = typeof eb.id === "string" ? eb.id : "";
          const original = state.scheduleBlocks.find((b) => b.id === id);
          if (!original) return [];
          return [{ ...eb, title: typeof eb.title === "string" && eb.title ? eb.title : original.title, startTime: typeof eb.startTime === "string" ? eb.startTime : original.startTime, endTime: typeof eb.endTime === "string" ? eb.endTime : original.endTime }];
        });
        // Store edit result in lastEditRef for correction memory
        lastEditRef.current = {
          summary: editResult.summary,
          editBlocks,
          editRecurring: editResult.editRecurring ?? [],
          newEvents: (editResult.newEvents ?? []) as ParsedEvent[],
          newRecurring: (editResult.newRecurring ?? []) as ParsedRecurringEvent[],
          healthPrefsUpdate: editResult.healthPrefsUpdate ?? undefined,
        };
        const nothingToApply = editBlocks.length === 0 && (editResult.editRecurring ?? []).length === 0 && (editResult.newEvents ?? []).length === 0 && (editResult.newRecurring ?? []).length === 0 && !editResult.healthPrefsUpdate;
        // If no matching block was found, show fallback message as a plain AI reply (no Apply prompt)
        if ((editResult.noMatchFound && editResult.fallbackMessage) || nothingToApply) {
          setMessages((prev) => [
            ...prev,
            { id: `ai-${Date.now()}`, role: "assistant", content: displayableReply(editResult.fallbackMessage || "I couldn't find that block on your calendar. Which session do you mean, and what day is it on?") },
          ]);
          setIsLoading(false);
          scrollToBottom();
          return;
        }

        // Store edit result in pendingEdit for user review before applying
        setPendingEdit({
          editBlocks,
          editRecurring: editResult.editRecurring ?? [],
          newEvents: (editResult.newEvents ?? []) as ParsedEvent[],
          newRecurring: (editResult.newRecurring ?? []) as ParsedRecurringEvent[],
          healthPrefsUpdate: editResult.healthPrefsUpdate ?? undefined,
          summary: editResult.summary,
        });

        setMessages((prev) => [
          ...prev,
          { id: `ai-${Date.now()}`, role: "assistant", content: displayableReply(editResult.summary) },
        ]);
        setIsLoading(false);
        scrollToBottom();
        return;
      }

      const memCtx = aiMemory ? buildMemoryContext(aiMemory) : undefined;

      // Build syllabus context from uploaded syllabi so AI knows about deadlines and course content
      let syllabusCtx = "";
      const syllabusImports = state.syllabusImports ?? [];
      if (syllabusImports.length > 0) {
        const syllabusLines: string[] = ["\n## Uploaded Syllabi (what you know about this student's courses):"];
        syllabusImports.forEach((si) => {
          syllabusLines.push(`\n### ${si.linkedClassName} (${si.courseName})`);
          if (si.courseDescription) {
            syllabusLines.push(`Course: ${si.courseDescription}`);
          }
          syllabusLines.push(`Uploaded: ${si.importedAt.slice(0, 10)} | ${si.itemCount} items added`);

          // Use stored extractedItems if available; otherwise fall back to tasks in state for this class
          let itemsToShow = si.extractedItems;
          if (!itemsToShow || itemsToShow.length === 0) {
            // Retroactive backfill: reconstruct from tasks linked to this class
            const linkedTasks = state.tasks.filter((t) => t.courseId === si.linkedClassId);
            if (linkedTasks.length > 0) {
              itemsToShow = linkedTasks.map((t) => ({
                name: t.name,
                dueDate: t.dueDate,
                type: "assignment",
                difficulty: t.difficulty,
                estimatedMinutes: t.estimatedMinutes,
              }));
            }
          }

          if (itemsToShow && itemsToShow.length > 0) {
            syllabusLines.push("Deadlines and assignments:");
            // Sort by due date
            const sorted = [...itemsToShow].sort((a, b) => a.dueDate.localeCompare(b.dueDate));
            sorted.forEach((item) => {
              const diffStr = item.difficulty ? ` (difficulty: ${item.difficulty}/5)` : "";
              const timeStr = item.estimatedMinutes ? ` ~${item.estimatedMinutes}min` : "";
              syllabusLines.push(`  - [${item.type}] ${item.name} — due ${item.dueDate}${diffStr}${timeStr}`);
            });
          }

          // Include the full raw syllabus text so the AI can answer detailed questions
          // about readings, page numbers, weekly schedules, and any other syllabus content.
          if (si.rawText && si.rawText.trim().length > 0) {
            // Truncate to 12 000 chars per syllabus to stay within token limits
            const truncated = si.rawText.length > 12000 ? si.rawText.slice(0, 12000) + "\n[...syllabus truncated for length...]" : si.rawText;
            syllabusLines.push(`\nFull syllabus text for ${si.linkedClassName}:\n${truncated}`);
          }
        });
        syllabusCtx = syllabusLines.join("\n");
      }

      const fullMemCtx = [memCtx, syllabusCtx].filter(Boolean).join("\n") || undefined;

      // Build full user data context for conversationalChat (the coming five weeks, with ids so it can propose moves)
      const chatScheduleCtx = blocksAround(1, 35)
        .map((b) => ({ id: b.id, title: b.title, date: b.date, startTime: b.startTime, endTime: b.endTime, type: b.type, completionStatus: b.completionStatus, accepted: b.accepted }));
      const chatTasksCtx = state.tasks
        .filter((t) => t.status !== "done" && t.status !== "skipped")
        .map((t) => ({ id: t.id, name: t.name, courseName: t.courseName, dueDate: t.dueDate, dueTime: t.dueTime, estimatedMinutes: t.estimatedMinutes, difficulty: t.difficulty, status: t.status, importance: t.importance }));
      const chatRecurringCtx = (state.recurringEvents ?? []).map((r) => ({ id: r.id, title: r.title, days: r.days, startTime: r.startTime, endTime: r.endTime }));
      const chatHealthCtx = state.healthPrefs ? {
        wakeTime: state.healthPrefs.wakeTime,
        bedtime: state.healthPrefs.bedtime,
        sleepTargetHours: state.healthPrefs.sleepTargetHours,
      } : undefined;
      const chatGradesCtx = (state.grades ?? []).map((g) => ({ classId: g.classId, letterGrade: g.letterGrade, numericGrade: g.numericGrade }));
      const chatResult = await mutate("ai.conversationalChat", {
        history: conversationHistory,
        message: text,
        classes: classOptions,
        today: todayString(),
        memoryContext: fullMemCtx,
        scheduleBlocks: chatScheduleCtx,
        tasks: chatTasksCtx,
        recurringEvents: chatRecurringCtx,
        healthPrefs: chatHealthCtx,
        grades: chatGradesCtx,
      });

      // A deadline that moved ("my midterm moved to Tuesday") goes to the review card as old → new due dates. On
      // Apply the normal preview re-plans every session around the new date (undoable); sessions are never moved here.
      if (chatResult.type === "deadline") {
        const changes = (chatResult.deadlineChanges ?? []).filter((dc) => state.tasks.some((t) => t.id === dc.taskId));
        if (changes.length > 0) {
          const reply = displayableReply(chatResult.reply);
          setPendingEdit({ editBlocks: [], editRecurring: [], newEvents: [], newRecurring: [], deadlineChanges: changes, summary: reply });
          setMessages((prev) => [
            ...prev,
            { id: `ai-${Date.now()}`, role: "assistant", content: reply },
          ]);
          return;
        }
      }

      // A proposed move of existing blocks goes to the review card (same as the edit endpoint's answers).
      if (chatResult.type === "edit") {
        const proposed = (chatResult.editBlocks ?? []).filter((eb) => state.scheduleBlocks.some((b) => b.id === eb.id));
        if (proposed.length > 0) {
          proposeBlockEdits(proposed, displayableReply(chatResult.reply));
          return;
        }
      }

      const aiMsg: ChatMessage = {
        id: `ai-${Date.now()}`,
        role: "assistant",
        // Never show raw JSON: a cut-off answer is reduced to its reply (lib/assistant-reply.ts).
        content: displayableReply(chatResult.reply),
        tasks: (chatResult.tasks ?? []) as ParsedTask[],
        events: (chatResult.events ?? []) as ParsedEvent[],
      };

      setMessages((prev) => [...prev, aiMsg]);

      if (chatResult.type === "schedule") {
        const newTasks = (chatResult.tasks ?? []) as ParsedTask[];
        const newEvents = (chatResult.events ?? []) as ParsedEvent[];
        const newRecurring = (chatResult.recurringEvents ?? []) as ParsedRecurringEvent[];
        const newClasses = (chatResult.newClasses ?? []) as ParsedNewClass[];
        setParsedTasks(newTasks);
        setParsedEvents(newEvents);
        setParsedRecurringEvents(newRecurring);
        setParsedNewClasses(newClasses);
        if (newTasks.length > 0 || newEvents.length > 0 || newRecurring.length > 0 || newClasses.length > 0) setShowConfirm(true);
      }
      // For 'question' and 'chat' types, just show the reply — no confirm panel
    } catch (error) {
      const detail = error instanceof Error && error.message
        ? ` (${error.message})`
        : "";
      setMessages((prev) => [
        ...prev,
        {
          id: `err-${Date.now()}`,
          role: "assistant",
          content:
            `I couldn't reach the planning assistant${detail} Your message is still here—check your connection and press Send again.`,
        },
      ]);
    } finally {
      setIsLoading(false);
      scrollToBottom();
    }
  }

  // Fire pending deep-link prompt now that handleSend is defined. It waits for the entitlement: with Pro it is sent,
  // without Pro it only fills the composer (Send then opens the paywall).
  useEffect(() => {
    const prompt = pendingPromptRef.current;
    if (!prompt || isProLoading) return;
    pendingPromptRef.current = null;
    setInputText(prompt);
    if (!isPro) return;
    const timer = setTimeout(() => {
      void handleSend(prompt);
    }, 400);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [promptParam, isProLoading]);

  function handleEditTask(index: number, field: keyof ParsedTask, value: string | number) {
    setParsedTasks((prev) => {
      const updated = [...prev];
      updated[index] = { ...updated[index]!, [field]: value };
      return updated;
    });
  }

  function handleRemoveTask(index: number) {
    setParsedTasks((prev) => prev.filter((_, i) => i !== index));
  }

  // ── Assistant proposals: preview -> apply (with undo) ─────────────────────
  // The assistant only PROPOSES. A proposal becomes an AssistantChange; the schedule is not touched until the
  // student has seen exactly what would move (ReplanPreviewBody) and clicks Apply. Applying stores an undo snapshot
  // (the confirmation below offers it), so every assistant change is one click to reverse.
  const changeFlow = useReplanFlow();
  // What to do once the previewed change has actually been applied: `what` says it in words ("3 sessions moved",
  // or ""), `blocks` is the plan as it was applied.
  const afterApplyRef = useRef<((applied: Applied) => void) | null>(null);

  function openChangePreview(change: AssistantChange, replan: boolean, afterApply: (applied: Applied) => void) {
    afterApplyRef.current = afterApply;
    changeFlow.open((s, now) => previewAssistantChange(s, change, { now, replan }));
  }

  function confirmChange() {
    const preview = changeFlow.preview;
    const applied: Applied = { what: preview ? describeReplanDiff(preview.diff) : "", blocks: preview?.next.scheduleBlocks ?? [] };
    if (changeFlow.apply()) {
      const done = afterApplyRef.current;
      afterApplyRef.current = null;
      done?.(applied);
    }
  }

  function cancelChange() {
    afterApplyRef.current = null;
    changeFlow.cancel();
    setMessages((prev) => [
      ...prev,
      { id: `sys-${Date.now()}`, role: "assistant", content: "No changes made. Your schedule is exactly as it was." },
    ]);
  }

  function handleAddAllTasks(autoSchedule: boolean) {
    if (parsedTasks.length === 0 && parsedEvents.length === 0 && parsedRecurringEvents.length === 0 && parsedNewClasses.length === 0) return;

    const now = new Date();
    const tasksToAdd = parsedTasks;
    const eventsToAdd = parsedEvents;
    const recurringToAdd = parsedRecurringEvents;
    const classesToAdd = parsedNewClasses;

    // A date already in the past is moved a week out here (the chat's parser sometimes returns last week's date).
    const newTasks: Task[] = tasksToAdd.map((pt) => taskFromParsed(pt, state.classes, { now, clampPastDue: true }));

    // One-time events become schedule blocks at exactly the times the AI specified.
    const newBlocks: ScheduleBlock[] = eventsToAdd.map((ev) => ({
      id: `event-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      type: blockTypeForEvent(ev.type),
      title: ev.title,
      date: ev.date,
      startTime: ev.startTime,
      endTime: ev.endTime,
      locked: false,
      accepted: true,
      color: EVENT_COLORS[blockTypeForEvent(ev.type)] ?? "#7C3AED",
      completionStatus: "pending" as const,
    }));
    const newClasses: ClassBlock[] = classesToAdd.map((nc) => ({
      id: `class-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      name: nc.name,
      days: nc.days,
      startTime: nc.startTime,
      endTime: nc.endTime,
      location: nc.location,
      color: nc.color,
    }));
    const newRecurringEvents: RecurringEvent[] = recurringToAdd.map((re) => ({
      id: `recurring-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      title: re.title,
      days: re.days,
      startTime: re.startTime,
      endTime: re.endTime,
      color: re.color ?? "#8B5CF6",
      locked: false,
      description: re.description,
    }));

    const taskCount = newTasks.length;
    const parts: string[] = [];
    if (taskCount > 0) parts.push(`${taskCount} task${taskCount !== 1 ? "s" : ""}`);
    if (eventsToAdd.length > 0) parts.push(`${eventsToAdd.length} event${eventsToAdd.length !== 1 ? "s" : ""}`);
    if (recurringToAdd.length > 0) parts.push(`${recurringToAdd.length} weekly event${recurringToAdd.length !== 1 ? "s" : ""}`);
    if (classesToAdd.length > 0) parts.push(`${classesToAdd.length} class${classesToAdd.length !== 1 ? "es" : ""}`);
    const itemStr = parts.join(" and ");

    const change: AssistantChange = {
      label: `Add ${itemStr}`,
      newTasks,
      newBlocks,
      newClasses,
      newRecurringEvents,
    };

    openChangePreview(change, autoSchedule || newRecurringEvents.length > 0, ({ blocks }) => {
      // Learn from added tasks and events for future personalization
      // "added" = the student just took these on (the only time lead time before a deadline means something).
      learnFromTasks(
        newTasks.map((t) => ({ id: t.id, name: t.name, courseName: t.courseName ?? "", estimatedMinutes: t.estimatedMinutes, difficulty: t.difficulty, dueDate: t.dueDate })),
        { source: "added" },
      ).then(loadAIMemory).then(setAiMemory).catch(() => {});
      learnFromEvents(eventsToAdd).catch(() => {});

      // Clear cards only now that the change really happened (Cancel keeps them for editing).
      setParsedTasks([]);
      setParsedEvents([]);
      setParsedRecurringEvents([]);
      setParsedNewClasses([]);
      setShowConfirm(false);

      // Said at once, from the plan that was just applied: what was added and where its study sessions landed, or
      // plainly that none could be planned. Always with Undo.
      setMessages((prev) => [
        ...prev,
        { id: `sys-${Date.now()}`, role: "assistant", content: addedConfirmation(itemStr, newTasks.map((task) => task.id), blocks) },
      ]);
      setTimeout(() => { inputRef.current?.focus(); scrollToBottom(); }, 150);
    });
  }

  // Review the pending AI edit (move a block, change a recurring event, new sleep window, ...) before applying it.
  function applyPendingEdit() {
    if (!pendingEdit) return;
    const edit = pendingEdit;
    const str = (value: unknown) => (typeof value === "string" && value ? value : undefined);

    const blockEdits: BlockEdit[] = edit.editBlocks.flatMap((eb) =>
      typeof eb.id === "string"
        ? [{ id: eb.id, startTime: str(eb.startTime), endTime: str(eb.endTime), date: str(eb.date), title: str(eb.title) }]
        : []
    );
    const recurringEdits: RecurringEdit[] = edit.editRecurring.flatMap((er) =>
      typeof er.id === "string" && state.recurringEvents.some((r) => r.id === er.id)
        ? [{ id: er.id, startTime: str(er.startTime), endTime: str(er.endTime), days: Array.isArray(er.days) ? (er.days as RecurringEvent["days"]) : undefined }]
        : []
    );
    const newBlocks: ScheduleBlock[] = edit.newEvents.map((ev: ParsedEvent) => ({
      id: `event-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      type: blockTypeForEvent(ev.type),
      title: ev.title,
      date: ev.date,
      startTime: ev.startTime,
      endTime: ev.endTime,
      locked: true,
      accepted: true,
      color: EVENT_COLORS[blockTypeForEvent(ev.type)] ?? "#7C3AED",
      completionStatus: "pending" as const,
    }));
    const newRecurringEvents: RecurringEvent[] = edit.newRecurring.map((re: ParsedRecurringEvent) => ({
      id: `recurring-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      title: re.title,
      days: re.days,
      startTime: re.startTime,
      endTime: re.endTime,
      color: re.color ?? "#8B5CF6",
      locked: false,
    }));
    // Sleep-window update (wake time, bedtime). Meal times are no longer a setting.
    const hpu = edit.healthPrefsUpdate;
    const sleepUpdate = hpu?.wakeTime || hpu?.bedtime ? { wakeTime: hpu.wakeTime, bedtime: hpu.bedtime } : undefined;

    const deadlineChanges = (edit.deadlineChanges ?? []).filter((dc) => state.tasks.some((t) => t.id === dc.taskId));
    const firstMoved = deadlineChanges[0] ? state.tasks.find((t) => t.id === deadlineChanges[0]!.taskId) : undefined;
    const label = deadlineChanges.length === 1 && firstMoved
      ? `Move ${firstMoved.name} to ${new Date(deadlineChanges[0]!.dueDate + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}`
      : deadlineChanges.length > 1
        ? `Move ${deadlineChanges.length} deadlines`
        : "Assistant change";
    const change: AssistantChange = { label, blockEdits, recurringEdits, newBlocks, newRecurringEvents, sleepUpdate, deadlineChanges };
    if (isEmptyChange(change)) {
      setPendingEdit(null);
      setMessages((prev) => [...prev, { id: `sys-${Date.now()}`, role: "assistant", content: "Nothing in that suggestion could be applied to your schedule." }]);
      return;
    }
    // Sessions are re-planned around changed commitments and a new sleep window (as before); a plain block move is shown as is.
    // A moved deadline always re-plans (that is the point: the sessions follow the new date).
    const replan = recurringEdits.length > 0 || newRecurringEvents.length > 0 || Boolean(sleepUpdate) || deadlineChanges.length > 0;

    openChangePreview(change, replan, ({ what }) => {
      setPendingEdit(null);
      setMessages((prev) => [
        ...prev,
        { id: `sys-${Date.now()}`, role: "assistant", content: `✅ Applied.\n\n${what ? `${capitalized(what)}. ` : ""}You can undo it here.` },
      ]);
      setTimeout(() => { inputRef.current?.focus(); scrollToBottom(); }, 150);
    });
  }

  // ── Rendering ────────────────────────────────────────────────
  // Display only: the welcome text is replaced by the examples (it stays in the conversation history).
  const visibleMessages = messages.filter((m) => !m.id.startsWith("welcome"));
  const foundCount = parsedTasks.length + parsedEvents.length + parsedRecurringEvents.length;
  const lastUserText = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
  const thinkingCopy = isEditIntent(lastUserText) || isDeadlineChangeIntent(lastUserText) ? "Working out what would move…" : "Reading your message…";
  const canSend = Boolean(inputText.trim()) && !isLoading;
  // The confirmation offers Undo for the change it confirms (same action and safety window as the Undo bar).
  const undoSnapshot = undoableChange(state, new Date());
  const lastDoneId = [...visibleMessages].reverse().find((m) => m.role === "assistant" && DONE_PREFIX.test(m.content))?.id;
  const ink = aiInk(colors);

  // A new message (or the thinking line) keeps the latest one in view.
  useEffect(() => {
    if (visibleMessages.length > 0) scrollToBottom();
  }, [visibleMessages.length, isLoading, scrollToBottom]);

  function pickExample(prompt: string) {
    setInputText(prompt);
    inputRef.current?.focus();
  }

  function undoLatest() {
    if (undoableChange(state, new Date())) dispatch({ type: "UNDO_REPLAN" });
  }

  function clearFound() {
    setParsedTasks([]);
    setParsedEvents([]);
    setParsedRecurringEvents([]);
    setParsedNewClasses([]);
    setShowConfirm(false);
  }

  function cancelFound() {
    clearFound();
    setMessages((prev) => [...prev, { id: `sys-${Date.now()}`, role: "assistant", content: "Nothing was added." }]);
  }

  function clearChat() {
    clearFound();
    setPendingEdit(null);
    setMessages([{ id: "welcome-reset", role: "assistant", content: "Ready for a fresh start! Tell me about your assignments." }]);
  }

  // Back to the tab it was opened from.
  function close() {
    goBack("today");
  }

  // A computer: the page fills the window exactly (the frame's padding is 34px over it and 72px under it), so the box
  // sits at the bottom of the window without the page scrolling.
  const pageStyle = desktop ? { minHeight: "calc(100dvh - 106px)" } : undefined;
  // A computer: the box and any proposal float over the end of the conversation, with no rule over them.
  const footerStyle = desktop ? { borderTop: "none", background: "linear-gradient(to bottom, transparent, var(--background) 22px)", padding: "22px 0 20px", gap: 12 } : undefined;

  const head = (extra?: ReactNode, pro?: boolean) => (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 8, paddingTop: 4 }}>
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 8 }}>
        {pro ? (
          <span style={{ alignSelf: "flex-start", display: "inline-flex", alignItems: "center", gap: 5, height: 22, padding: "0 7px", borderRadius: 6, border: `1px solid ${alpha(colors.violet, 0.55)}`, background: alpha(colors.violet, 0.16) }}>
            <Icon name="crown" size={13} color={ink} />
            <span style={{ fontFamily: MONO_FONT, fontSize: 12, lineHeight: "16px", fontWeight: 600, letterSpacing: 1, textTransform: "uppercase", color: ink }}>Pro</span>
          </span>
        ) : null}
        <div style={{ display: "flex", alignItems: "center", gap: 8, minHeight: 44 }}>
          <Icon name="spark" size={20} color={ink} />
          <h1 className="screen-title compact" style={{ margin: 0 }}>Trajectory AI</h1>
        </div>
      </div>
      {extra}
      <HeadButton icon="close" label="Close Trajectory AI" onPress={close} />
    </div>
  );

  // Entitlement still loading: don't flash the Pro note at a paying student.
  if (isProLoading) {
    return (
      <div className="screen ai-page" style={pageStyle}>
        {head()}
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <Spinner color={colors.violet} track={colors.borderStrong} />
        </div>
      </div>
    );
  }

  // Without Pro: the same page with a PRO tag. Sending a message or picking an example opens the paywall (no request
  // is sent; the typed text stays for after the purchase), and under the examples two free ways to change the plan.
  if (!isPro) {
    const openPaywall = () => navigate("paywall");
    return (
      <div className="screen ai-page" style={pageStyle}>
        {head(undefined, true)}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 14, paddingTop: 4, paddingBottom: 14 }}>
          <ExampleList colors={colors} prompts={EXAMPLE_PROMPTS} onPick={openPaywall} pickHint={PRO_HINT} />
          <div style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "12px 14px", borderRadius: 14, border: `1px solid ${alpha(colors.violet, 0.5)}`, background: alpha(colors.violet, 0.14) }}>
            <Icon name="crown" size={20} color={ink} />
            <span style={{ flex: 1, fontSize: 14, lineHeight: "20px", color: ink }}>Trajectory AI is part of Trajectory Pro. Send a message or pick an example to see the plans.</span>
          </div>
          <SectionLabel title="Or change the plan yourself" style={{ marginTop: 4, marginBottom: -6 }} />
          <div className="group">
            <FreeRow icon="bolt" title="Replan today" detail="Preview what moves first" label="Replan today: preview what moves before anything changes" onPress={() => openReplan({ scope: "today" })} />
            <FreeRow icon="plus" title="Add a task" detail="Type it in yourself" label="Add a task yourself" onPress={() => openAdd({ kind: "task" })} />
          </div>
        </div>
        <div className="flow-footer" style={footerStyle}>
          <Composer colors={colors} inputRef={inputRef} value={inputText} onChangeText={setInputText} placeholder={PLACEHOLDER} canSend={Boolean(inputText.trim())} onSend={openPaywall} sendHint={PRO_HINT} />
        </div>
      </div>
    );
  }

  // The pending change as "old → new" rows (also the text quoted by its Report link).
  const pendingRows = pendingEdit ? pendingEditRows(pendingEdit, state) : [];
  const pendingHeadline = pendingEdit ? pendingEditHeadline(pendingEdit) : "";
  const hasConversation = visibleMessages.length > 0 || foundCount > 0 || pendingEdit !== null;
  const foundLine = [
    parsedTasks.length > 0 ? "Study time is planned before each due date." : "",
    parsedEvents.length + parsedRecurringEvents.length > 0 ? "Nothing is planned over an event." : "",
  ].filter(Boolean).join(" ");
  const dockLine = { fontSize: 13, lineHeight: "18px", color: colors.muted, margin: 0 } as const;

  return (
    <div className="screen ai-page" style={pageStyle}>
      {head(hasConversation ? <HeadButton icon="trash" label="Clear the conversation" onPress={clearChat} /> : undefined)}

      {/* The conversation (before anything is said: what this is for, and four things to try) */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: desktop ? 20 : 14, paddingTop: 4, paddingBottom: 14, justifyContent: desktop && visibleMessages.length === 0 && !isLoading ? "center" : undefined }}>
        {visibleMessages.length === 0 ? (
          <div style={{ display: "flex", flexDirection: "column", gap: desktop ? 18 : 14 }}>
            {desktop ? (
              <span aria-hidden style={{ width: 56, height: 56, borderRadius: 16, display: "inline-flex", alignItems: "center", justifyContent: "center", background: alpha(colors.violet, 0.16), border: `1px solid ${alpha(colors.violet, 0.4)}` }}>
                <Icon name="spark" size={26} color={ink} />
              </span>
            ) : null}
            <p style={{ margin: 0, fontSize: desktop ? 18 : 15, lineHeight: desktop ? "26px" : "22px", color: desktop ? colors.foreground : colors.muted, maxWidth: desktop ? 560 : undefined }}>{LEDE}</p>
            <ExampleList colors={colors} prompts={EXAMPLE_PROMPTS} onPick={pickExample} />
            <p style={{ margin: 0, fontSize: 13, lineHeight: "18px", color: colors.muted }}>{FOOTNOTE}</p>
          </div>
        ) : (
          visibleMessages.map((item) => <MessageRow key={item.id} item={item} colors={colors} undoableId={lastDoneId} undoSnapshot={undoSnapshot} onUndo={undoLatest} />)
        )}
        {isLoading ? <ThinkingRow colors={colors} copy={thinkingCopy} /> : null}
      </div>

      <div className="flow-footer" style={footerStyle}>
        {/* Things to add: check them (click a task to correct it), then add them all at once */}
        {foundCount > 0 && showConfirm ? (
          <ReviewDock
            colors={colors}
            title="To add"
            right={parsedTasks.length > 0 ? <DockHint colors={colors} label="Click a task to edit it" /> : undefined}
            note={{
              surface: "parsed tasks",
              content: () => parsedItemsText({ tasks: parsedTasks, events: parsedEvents, recurring: parsedRecurringEvents, classes: parsedNewClasses }),
              text: "AI-generated. It can be wrong, so check before you add.",
            }}
            footer={foundLine ? <p style={dockLine}>{foundLine} Nothing is added until you say so.</p> : undefined}
            actions={
              <>
                <PrimaryButton
                  label={foundCount === 1 ? "Add" : foundCount === 2 ? "Add both" : `Add all ${foundCount}`}
                  left={<Icon name="plus" size={18} color="#FFFFFF" strokeWidth={2.4} />}
                  onPress={() => handleAddAllTasks(true)}
                  style={{ flex: 1 }}
                />
                <PrimaryButton label="Cancel" tone="ghost" onPress={cancelFound} style={{ flex: 1 }} ariaLabel="Cancel: add nothing" />
              </>
            }
          >
            <ReviewList>
              {parsedTasks.map((task, index) => (
                <ParsedTaskCard key={`task-${index}`} task={task} index={index} first={index === 0} onEdit={handleEditTask} onRemove={handleRemoveTask} colors={colors} />
              ))}
              {parsedEvents.map((ev, index) => (
                <ItemRow
                  key={`event-${index}`}
                  colors={colors}
                  icon="cal"
                  kind="Event"
                  first={parsedTasks.length + index === 0}
                  title={ev.title}
                  meta={`${new Date(ev.date + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })} · ${formatTime(ev.startTime)} – ${formatTime(ev.endTime)}`}
                  onRemove={() => setParsedEvents((prev) => prev.filter((_, i) => i !== index))}
                />
              ))}
              {parsedRecurringEvents.map((re, index) => (
                <ItemRow
                  key={`recurring-${index}`}
                  colors={colors}
                  icon="repeat"
                  kind="Every week"
                  first={parsedTasks.length + parsedEvents.length + index === 0}
                  title={re.title}
                  meta={`${re.days.join(", ")} · ${formatTime(re.startTime)} – ${formatTime(re.endTime)}`}
                  onRemove={() => setParsedRecurringEvents((prev) => prev.filter((_, i) => i !== index))}
                />
              ))}
            </ReviewList>
          </ReviewDock>
        ) : null}

        {/* A change to review: old → new, and nothing changes until Apply */}
        {pendingEdit ? (
          <ReviewDock
            colors={colors}
            title="What would change"
            note={{
              surface: "plan change",
              content: () => planChangeText(displayableReply(pendingEdit.summary), pendingRows),
              text: "AI-generated. It can be wrong, so check before you apply.",
            }}
            footer={<p style={dockLine}>{pendingHeadline} Nothing changes until you apply it.</p>}
            actions={
              <>
                <PrimaryButton label="Apply" left={<Icon name="check" size={18} color="#FFFFFF" strokeWidth={2.4} />} onPress={applyPendingEdit} style={{ flex: 1 }} ariaLabel="Apply: see exactly what moves, then confirm" />
                <PrimaryButton
                  label="Cancel"
                  tone="ghost"
                  onPress={() => {
                    setPendingEdit(null);
                    setMessages((prev) => [...prev, { id: `sys-${Date.now()}`, role: "assistant", content: "No changes made." }]);
                  }}
                  style={{ flex: 1 }}
                  ariaLabel="Cancel: change nothing"
                />
              </>
            }
          >
            {/* Display only: each row reads "old → new" against the calendar as it is now. */}
            <ReviewList>
              {pendingRows.map((row, index) => (
                <ChangeRow key={row.key} title={blockDisplayTitle(row.title)} from={row.from} to={row.to} isNew={row.isNew} first={index === 0} colors={colors} />
              ))}
            </ReviewList>
          </ReviewDock>
        ) : null}

        <Composer
          colors={colors}
          inputRef={inputRef}
          value={inputText}
          onChangeText={setInputText}
          placeholder={foundCount > 0 ? "Add more, or correct something" : PLACEHOLDER}
          canSend={canSend}
          onSend={() => void handleSend()}
        />
      </div>

      {/* Every change the assistant proposes is shown exactly as the planner would make it before it is applied
          (and can be undone from the confirmation here or the app-wide Undo). */}
      {changeFlow.preview ? (
        <Sheet open onClose={cancelChange} ariaLabel="Review the changes">
          <ReplanPreviewBody
            title="Review the changes"
            summary={changeFlow.preview.summary}
            diff={changeFlow.preview.diff}
            shortfalls={changeFlow.preview.shortfalls}
            applyLabel="Apply changes"
            onApply={confirmChange}
            onCancel={cancelChange}
            next={changeFlow.preview.next}
          >
            <AiContentLabel surface="plan change" content={() => changeFlow.preview?.summary ?? ""} />
          </ReplanPreviewBody>
        </Sheet>
      ) : null}
    </div>
  );
}

// ── Small pieces of the page ─────────────────────────────────

function HeadButton({ icon, label, onPress }: { icon: IconName; label: string; onPress: () => void }) {
  const colors = useColors();
  return (
    <HeaderIconButton onPress={onPress} ariaLabel={label}>
      <Icon name={icon} size={18} color={colors.muted} strokeWidth={icon === "close" ? 2 : 1.8} />
    </HeaderIconButton>
  );
}

/** Without Pro: one of the two free ways to change the plan. */
function FreeRow({ icon, title, detail, label, onPress }: { icon: IconName; title: string; detail: string; label: string; onPress: () => void }) {
  const colors = useColors();
  return (
    <button type="button" className="row pressable" aria-label={label} onClick={onPress} style={{ padding: "9px 14px" }}>
      <span className="well" style={{ background: alpha(colors.peri, 0.12) }}>
        <Icon name={icon} size={18} color={colors.peri} />
      </span>
      <span className="row-text" style={{ textAlign: "left" }}>
        <span style={{ display: "block", fontSize: 15, lineHeight: "20px", fontWeight: 600, color: colors.foreground }}>{title}</span>
        <span style={{ display: "block", fontSize: 13, lineHeight: "18px", color: colors.muted }}>{detail}</span>
      </span>
      <Icon name="chevronRight" size={18} color={colors.muted} />
    </button>
  );
}
