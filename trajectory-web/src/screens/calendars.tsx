/**
 * Calendars screen, reached from Settings (the iPhone app's app/google-calendar-sync.tsx). What comes in and what
 * goes out, in a browser:
 *
 *  - Your plan as a calendar file: every class, session and deadline as an .ics file (lib/ics-export.ts) for Google
 *    Calendar, Apple Calendar or Outlook. The iPhone writes the plan straight into Apple Calendar; a browser hands
 *    over a file.
 *  - Import from a calendar link: a one-off import from a secret iCal (ICS) link, fetched by this browser, in a sheet.
 *  - Google Calendar (server sync): connecting is retired for now (lib/config.ts GOOGLE_CALENDAR_CONNECT_OFFERED).
 *    A student who connected before keeps a small section to sync or disconnect it.
 *
 * The iPhone's two other groups (its calendars read for busy time, the plan mirrored to Apple Calendar) cannot exist
 * here: one note says so. What every line says is lib/calendars-view.ts.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { DesktopPageHead, Panel, PanelBody } from "../components/desktop-panels";
import { alpha, radius } from "../engine/design";
import { localDateKey, generateId } from "../engine/utils";
import {
  CALENDAR_FILE_DETAIL,
  CALENDAR_FILE_SAVED,
  CALENDAR_LINK_DETAIL,
  calendarsSections,
  GOOGLE_DISCONNECT_QUESTION,
  GOOGLE_HOW_IT_WORKS,
  GOOGLE_NOT_STARTED,
  GOOGLE_SIGN_IN_FAILED,
  googleConnectionRow,
  googleNote,
  googleSyncBlocked,
  googleSyncResult,
  ICS_FACTS,
  ICS_GUIDE_FALLBACK,
  ICS_GUIDE_URL,
  ICS_NOTHING_FOUND,
  ICS_STEPS,
  icsFetchUrl,
  icsImportFailure,
  icsLinkProblem,
  icsNothingNew,
  icsResultLine,
  planIcsImport,
  type IcsImportPlan,
  type StatusLine,
} from "../lib/calendars-view";
import { GOOGLE_CALENDAR_CONNECT_OFFERED } from "../lib/config";
import { disconnectGCal, fetchGCalEvents, fetchGCalStatus, gcalEventsAction, NO_GCAL_STATUS, startGCalConnect, triggerManualSync, type GCalStatus } from "../lib/gcal-sync";
import { buildPlanIcs, downloadTextFile } from "../lib/ics-export";
import { goBack } from "../router";
import { useApp } from "../state/app-provider";
import { Icon, type IconName } from "../ui/icon";
import { useDesktop } from "../ui/layout";
import { FieldGroup, FieldLabel, FieldPickRow, FieldRow, HeaderIconButton, MONO_FONT, Note, PrimaryButton, ScreenHeader, SectionLabel } from "../ui/primitives";
import { Sheet, SheetBody, SheetHead } from "../ui/sheet";
import { useColors } from "../ui/theme";

const LINK_TEXT = { fontSize: 15, lineHeight: "20px", fontWeight: 600 } as const;
const LINK_BTN = { minHeight: 44, minWidth: 44, display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6, padding: "0 10px" } as const;

export function CalendarsScreen() {
  const colors = useColors();
  const { state } = useApp();
  // Google Calendar through the server: connecting is retired for now (lib/config.ts), so the section only shows for
  // a connection made before, to sync or disconnect it. That connection (tokens, webhook channel) lives on the server
  // under the account. Everything else on this screen runs in this browser.
  const sections = calendarsSections({
    deviceSupported: false,
    appleSupported: false,
    googleShown: GOOGLE_CALENDAR_CONNECT_OFFERED || state.googleCalendarConnected,
  });
  const desktop = useDesktop();
  const [linkOpen, setLinkOpen] = useState(false);
  const [fileSaved, setFileSaved] = useState(false);

  function exportCalendar() {
    downloadTextFile(`trajectory-${localDateKey(new Date())}.ics`, buildPlanIcs(state), "text/calendar");
    setFileSaved(true);
  }

  if (desktop) {
    return (
      <div className="screen" style={{ gap: 22 }}>
        <DesktopPageHead back={{ onPress: () => goBack("settings"), ariaLabel: "Back" }} eyebrow="Your time" title="Calendars" />

        {/* A browser cannot read the iPhone's calendars: say so, once, instead of a nearly empty page. */}
        {sections.note ? <Note>{sections.note}</Note> : null}

        {/* The plan out, as a file; a calendar in, from a secret link */}
        <div className="card-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 16 }}>
          <ActionCard icon="cal" label="Calendar file" detail={CALENDAR_FILE_DETAIL} onPress={exportCalendar} ariaLabel="Download the plan as a calendar file" action={<><Icon name="download" size={16} color={colors.peri} />Download</>} />
          <ActionCard icon="link" label="Import from a calendar link" detail={CALENDAR_LINK_DETAIL} onPress={() => setLinkOpen(true)} ariaLabel={`Import from a calendar link. ${CALENDAR_LINK_DETAIL}`} chevron />
        </div>
        {fileSaved ? <Note tone="green" icon="check" role="status">{CALENDAR_FILE_SAVED}</Note> : null}

        {/* Google Calendar through the server: only a connection made before (connecting is retired for now) */}
        {sections.google ? <GoogleCalendarGroup desktop /> : null}

        <CalendarLinkSheet open={linkOpen} onClose={() => setLinkOpen(false)} />
      </div>
    );
  }

  return (
    <div className="screen" style={{ maxWidth: 560, gap: 16 }}>
      <div style={{ display: "flex", paddingTop: 4 }}>
        <HeaderIconButton onPress={() => goBack("settings")} ariaLabel="Back">
          <Icon name="chevronLeft" size={20} color={colors.foreground} strokeWidth={2} />
        </HeaderIconButton>
      </div>
      <ScreenHeader eyebrow="Your time" title="Calendars" />

      {/* A browser cannot read the iPhone's calendars: say so, once, instead of a nearly empty page. */}
      {sections.note ? <Note>{sections.note}</Note> : null}

      {/* The plan out, as a file; a calendar in, from a secret link */}
      <FieldGroup>
        <FieldPickRow first icon="cal" label="Calendar file" detail={CALENDAR_FILE_DETAIL} value="Download" chevron={false} onPress={exportCalendar} ariaLabel="Download the plan as a calendar file" />
        <FieldPickRow icon="link" label="Import from a calendar link" detail={CALENDAR_LINK_DETAIL} onPress={() => setLinkOpen(true)} ariaLabel={`Import from a calendar link. ${CALENDAR_LINK_DETAIL}`} />
      </FieldGroup>
      {fileSaved ? <Note tone="green" icon="check" role="status">{CALENDAR_FILE_SAVED}</Note> : null}

      {/* Google Calendar through the server: only a connection made before (connecting is retired for now) */}
      {sections.google ? <GoogleCalendarGroup /> : null}

      <CalendarLinkSheet open={linkOpen} onClose={() => setLinkOpen(false)} />
    </div>
  );
}

/** One way in or out, as a card on a computer: its icon, what it is, the sentence under it, and what pressing it does. */
function ActionCard({ icon, label, detail, onPress, ariaLabel, action, chevron }: { icon: IconName; label: string; detail: string; onPress: () => void; ariaLabel: string; action?: ReactNode; chevron?: boolean }) {
  const colors = useColors();
  return (
    <button type="button" className="card lift" onClick={onPress} aria-label={ariaLabel} style={{ display: "flex", flexDirection: "column", alignItems: "stretch", gap: 14, padding: 20, width: "100%", textAlign: "left", color: "inherit" }}>
      <span style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <span className="well" style={{ width: 42, height: 42, borderRadius: 12, background: alpha(colors.peri, 0.12) }}>
          <Icon name={icon} size={20} color={colors.peri} />
        </span>
        {chevron ? <Icon name="chevronRight" size={18} color={colors.muted} /> : null}
      </span>
      <span style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={{ fontSize: 16.5, lineHeight: "22px", fontWeight: 600, letterSpacing: -0.2, color: colors.foreground }}>{label}</span>
        <span style={{ fontSize: 13.5, lineHeight: "20px", color: colors.muted }}>{detail}</span>
      </span>
      {action ? <span style={{ display: "inline-flex", alignItems: "center", gap: 7, marginTop: "auto", fontSize: 14.5, fontWeight: 600, color: colors.peri }}>{action}</span> : null}
    </button>
  );
}

/**
 * Google Calendar through the server, for a connection made before: its state and when it last synced, what its
 * events do in the plan, "Sync now" (the result is said here) and "Disconnect" (it asks first, here). The connect
 * path is kept for the day connecting is offered again (lib/config.ts); nobody reaches it today.
 */
function GoogleCalendarGroup({ desktop = false }: { desktop?: boolean }) {
  const colors = useColors();
  const { state: appState, dispatch } = useApp();
  const googleConnected = appState.googleCalendarConnected;

  const [gcalStatus, setGcalStatus] = useState<GCalStatus>(NO_GCAL_STATUS);
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [syncResult, setSyncResult] = useState<StatusLine | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const loadGCalData = useCallback(async () => {
    // lib/api.ts restCall carries the session's token; the server answers "not connected" without one.
    const [status, events] = await Promise.all([fetchGCalStatus(), fetchGCalEvents()]);
    if (!mounted.current) return;
    setGcalStatus(status);
    if (events.connected) dispatch(gcalEventsAction(events));
    setLoadingStatus(false);
  }, [dispatch]);

  useEffect(() => {
    void loadGCalData();
  }, [loadGCalData]);

  // Poll every 30s when connected
  useEffect(() => {
    if (!gcalStatus.connected) return;
    const poll = setInterval(() => void loadGCalData(), 30_000);
    return () => clearInterval(poll);
  }, [gcalStatus.connected, loadGCalData]);

  const handleConnect = useCallback(async () => {
    setConnecting(true);
    setProblem(null);
    try {
      // The session token stays in the Authorization header; the server returns a Google consent URL whose `state`
      // is a single-use nonce (the token never appears in a URL).
      const started = await startGCalConnect();
      if ("error" in started) {
        setConnecting(false);
        setProblem(started.error || GOOGLE_NOT_STARTED);
        return;
      }
      const opened = window.open(started.url, "_blank", "noopener");
      if (!opened) throw new Error("blocked");
      setConnecting(false);
      await loadGCalData();
    } catch {
      setConnecting(false);
      setProblem(GOOGLE_SIGN_IN_FAILED);
    }
  }, [loadGCalData]);

  const handleManualSync = useCallback(async () => {
    setSyncing(true);
    setSyncResult(null);
    const synced = await triggerManualSync();
    await loadGCalData();
    if (!mounted.current) return;
    setSyncing(false);
    // Said on the page, under the connection: how many came in, or that it did not go through.
    setSyncResult(googleSyncResult(synced));
  }, [loadGCalData]);

  const disconnect = useCallback(async () => {
    setConfirmingDisconnect(false);
    await disconnectGCal();
    dispatch({ type: "CLEAR_GOOGLE_CALENDAR" });
    if (!mounted.current) return;
    setGcalStatus(NO_GCAL_STATUS);
  }, [dispatch]);

  const connection = googleConnectionRow({ loading: loadingStatus, connected: gcalStatus.connected, channelActive: gcalStatus.channelActive, lastSync: gcalStatus.lastSync, now: new Date() });
  const googleEventCount = appState.googleCalendarEvents.filter((event) => event.status !== "cancelled").length;
  const syncBlocked = googleSyncBlocked({ loading: loadingStatus, connected: gcalStatus.connected });
  const hasConnection = googleConnected || gcalStatus.connected;

  // The two answers to "Disconnect Google Calendar?": the only way to disconnect goes through the question.
  const disconnectAnswers = (
    <>
      <button type="button" className="link danger" onClick={() => void disconnect()} aria-label="Yes, disconnect Google Calendar" style={{ ...LINK_BTN, ...LINK_TEXT }}>Disconnect</button>
      <button type="button" className="link" onClick={() => setConfirmingDisconnect(false)} aria-label="Keep Google Calendar connected" style={{ ...LINK_BTN, ...LINK_TEXT }}>Keep</button>
    </>
  );
  const howItWorks =
    GOOGLE_CALENDAR_CONNECT_OFFERED && !hasConnection ? (
      <FieldGroup>
        {GOOGLE_HOW_IT_WORKS.map((item, index) => (
          <FieldRow key={item.title} first={index === 0} icon={item.icon} label={item.title} detail={item.detail} />
        ))}
      </FieldGroup>
    ) : null;

  if (desktop) {
    return (
      <Panel title="Google Calendar" icon="calSync">
        <FieldRow first icon="calSync" label={connection.label} detail={connection.detail || undefined} />
        <PanelBody gap={14}>
          <p className="caption" style={{ margin: 0 }}>{googleNote({ connected: googleConnected, events: googleEventCount })}</p>
          {syncResult ? <Note tone={syncResult.tone === "red" ? "red" : "green"} icon={syncResult.tone === "red" ? "warning" : "check"} role="alert">{syncResult.text}</Note> : null}
          {problem ? <Note tone="red" icon="warning" role="alert">{problem}</Note> : null}
          {hasConnection ? (
            <>
              {syncBlocked ? <p role="alert" style={{ margin: 0, fontSize: 14, lineHeight: "19px", fontWeight: 600, color: colors.gold }}>{syncBlocked}</p> : null}
              {confirmingDisconnect ? (
                <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: "4px 16px" }}>
                  <p role="alert" style={{ flex: "1 1 320px", margin: 0, fontSize: 14, lineHeight: "20px", color: colors.foreground }}>{GOOGLE_DISCONNECT_QUESTION}</p>
                  <div style={{ display: "flex", columnGap: 6 }}>
                    {disconnectAnswers}
                  </div>
                </div>
              ) : (
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <PrimaryButton tone="ghost" label="Sync now" left={syncing ? undefined : <Icon name="refresh" size={16} color={colors.foreground} />} onPress={() => void handleManualSync()} disabled={syncing || !gcalStatus.connected} loading={syncing} style={{ minWidth: 148 }} />
                  <button type="button" className="link danger" onClick={() => setConfirmingDisconnect(true)} aria-label="Disconnect Google Calendar" style={{ ...LINK_BTN, ...LINK_TEXT }}>Disconnect</button>
                </div>
              )}
            </>
          ) : (
            <PrimaryButton size="lg" label="Connect Google Calendar" onPress={() => void handleConnect()} disabled={connecting} loading={connecting} left={connecting ? undefined : <Icon name="calSync" size={19} color="#FFFFFF" />} style={{ alignSelf: "flex-start" }} />
          )}
          {howItWorks}
        </PanelBody>
      </Panel>
    );
  }

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <SectionLabel title="Google Calendar" />
      <FieldGroup>
        <FieldRow first icon="calSync" label={connection.label} detail={connection.detail || undefined} />
      </FieldGroup>
      <p className="caption" style={{ margin: 0, padding: "0 2px" }}>{googleNote({ connected: googleConnected, events: googleEventCount })}</p>

      {syncResult ? (
        <Note tone={syncResult.tone === "red" ? "red" : "green"} icon={syncResult.tone === "red" ? "warning" : "check"} role="alert">{syncResult.text}</Note>
      ) : null}
      {problem ? <Note tone="red" icon="warning" role="alert">{problem}</Note> : null}

      {hasConnection ? (
        <>
          {syncBlocked ? <p role="alert" style={{ margin: 0, fontSize: 14, lineHeight: "19px", fontWeight: 600, textAlign: "center", color: colors.gold }}>{syncBlocked}</p> : null}
          <PrimaryButton tone="ghost" fullWidth label="Sync now" left={syncing ? undefined : <Icon name="refresh" size={16} color={colors.foreground} />} onPress={() => void handleManualSync()} disabled={syncing || !gcalStatus.connected} loading={syncing} />
          {confirmingDisconnect ? (
            <div style={{ padding: "0 2px" }}>
              <p role="alert" style={{ margin: 0, fontSize: 14, lineHeight: "20px", color: colors.foreground }}>{GOOGLE_DISCONNECT_QUESTION}</p>
              <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "flex-end", columnGap: 6 }}>
                {disconnectAnswers}
              </div>
            </div>
          ) : (
            <button type="button" className="link danger" onClick={() => setConfirmingDisconnect(true)} aria-label="Disconnect Google Calendar" style={{ ...LINK_BTN, ...LINK_TEXT, alignSelf: "center" }}>Disconnect</button>
          )}
        </>
      ) : (
        <PrimaryButton size="lg" fullWidth label="Connect Google Calendar" onPress={() => void handleConnect()} disabled={connecting} loading={connecting} left={connecting ? undefined : <Icon name="calSync" size={19} color="#FFFFFF" />} />
      )}

      {/* How it works: only while connecting is offered and nothing is connected yet */}
      {howItWorks}
    </section>
  );
}

/** A numbered line of "How to get the link", and a bullet of "What gets imported". */
function Step({ number, children }: { number: number; children: ReactNode }) {
  const colors = useColors();
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 12, padding: "10px 14px" }}>
      <span style={{ fontFamily: MONO_FONT, fontSize: 13, lineHeight: "20px", fontWeight: 600, width: 14, color: colors.peri }}>{number}</span>
      <span style={{ flex: 1, fontSize: 14, lineHeight: "20px", color: colors.foreground }}>{children}</span>
    </div>
  );
}

/**
 * "Import from a calendar link": how to get the link, the field, what comes in, and "Import events". This browser
 * fetches the file itself. What goes wrong is said in the sheet (nothing found, the link could not be read, a
 * service that does not let browsers read it); when it worked, the sheet lists what came in.
 */
function CalendarLinkSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const colors = useColors();
  const { state, dispatch } = useApp();
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  // One import at a time counts: closing the sheet (or starting over) while the file is still coming drops it.
  const run = useRef(0);
  const [problem, setProblem] = useState<StatusLine | null>(null);
  const [guideFailed, setGuideFailed] = useState(false);
  const [done, setDone] = useState<Pick<IcsImportPlan, "names" | "leftOut" | "past" | "already"> | null>(null);
  const blocked = icsLinkProblem(url);

  const startOver = () => {
    setDone(null);
    setUrl("");
    setProblem(null);
  };

  // Closed after an import, the next opening starts with an empty field; closed half-way, the link is kept.
  const close = () => {
    // A file still on its way is not added behind the student's back after the sheet is gone.
    run.current++;
    setLoading(false);
    if (done) startOver();
    onClose();
  };

  const importEvents = async () => {
    if (blocked || loading) return;
    const mine = ++run.current;
    setLoading(true);
    setProblem(null);
    try {
      const response = await fetch(icsFetchUrl(url), { headers: { Accept: "text/calendar, text/plain, */*" } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      if (run.current !== mine) return;
      const plan = planIcsImport(text, { now: new Date(), makeId: generateId, existing: { tasks: state.tasks, recurringEvents: state.recurringEvents } });
      if (plan.items.length === 0) {
        setProblem({ text: plan.found > 0 ? icsNothingNew(plan) : ICS_NOTHING_FOUND, tone: "gold" });
        return;
      }
      for (const item of plan.items) {
        if (item.kind === "recurring") dispatch({ type: "ADD_RECURRING_EVENT", payload: item.event });
        else dispatch({ type: "ADD_TASK", payload: item.task });
      }
      setDone({ names: plan.names, leftOut: plan.leftOut, past: plan.past, already: plan.already });
    } catch (err) {
      if (run.current === mine) setProblem({ text: icsImportFailure(err), tone: "red" });
    } finally {
      if (run.current === mine) setLoading(false);
    }
  };

  const openGuide = () => {
    setGuideFailed(false);
    const opened = window.open(ICS_GUIDE_URL, "_blank", "noopener");
    if (!opened) setGuideFailed(true);
  };

  return (
    <Sheet open={open} onClose={close} ariaLabel="Import from a calendar link">
      <SheetBody gap={16}>
        <SheetHead title={done ? "Import complete." : "Import from a calendar link"} onClose={close} />

        {done ? (
          <>
            <p className="sheet-sub" style={{ marginTop: -8 }}>{icsResultLine(done)}</p>
            <FieldGroup>
              {done.names.map((name, index) => (
                <div key={`${index}-${name}`} style={{ display: "flex", alignItems: "center", gap: 10, minHeight: 46, padding: "8px 14px" }}>
                  <Icon name="check" size={18} color={colors.success} strokeWidth={2.4} />
                  <span className="clamp2" style={{ flex: 1, fontSize: 15, lineHeight: "20px", color: colors.foreground }}>{name}</span>
                </div>
              ))}
            </FieldGroup>
            <PrimaryButton size="lg" fullWidth label="Done" onPress={close} />
            <button type="button" className="link" onClick={startOver} aria-label="Import another calendar" style={{ ...LINK_BTN, ...LINK_TEXT, alignSelf: "center", marginTop: -6 }}>Import another calendar</button>
          </>
        ) : (
          <>
            <p className="sheet-sub" style={{ marginTop: -8 }}>{CALENDAR_LINK_DETAIL}</p>

            <div>
              <FieldLabel>How to get the link</FieldLabel>
              <FieldGroup>
                {ICS_STEPS.map((step, index) => (
                  <Step key={step} number={index + 1}>{step}</Step>
                ))}
              </FieldGroup>
              <button type="button" className="link" onClick={openGuide} aria-label="View Google's guide, in a new tab" style={{ ...LINK_BTN, ...LINK_TEXT, padding: "0 2px" }}>
                View Google&apos;s guide
                <Icon name="external" size={15} color={colors.peri} />
              </button>
              {guideFailed ? <p role="alert" style={{ margin: 0, fontSize: 13, lineHeight: "18px", color: colors.gold }}>{ICS_GUIDE_FALLBACK}</p> : null}
            </div>

            <div>
              <FieldLabel>Calendar link</FieldLabel>
              <textarea
                className="input"
                value={url}
                onChange={(event) => {
                  setUrl(event.target.value);
                  setProblem(null);
                }}
                placeholder="https://calendar.google.com/calendar/ical/..."
                rows={3}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                aria-label="Calendar link"
                style={{ minHeight: 84, padding: "12px 14px", borderRadius: radius.md, fontFamily: MONO_FONT, fontSize: 13, lineHeight: "19px", resize: "vertical" }}
              />
            </div>

            <div>
              <FieldLabel>What gets imported</FieldLabel>
              <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 6 }}>
                {ICS_FACTS.map((fact) => (
                  <li key={fact} style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
                    <span style={{ width: 5, height: 5, borderRadius: 3, marginTop: 8, flexShrink: 0, background: colors.peri }} />
                    <span style={{ flex: 1, fontSize: 14, lineHeight: "20px", color: colors.muted }}>{fact}</span>
                  </li>
                ))}
              </ul>
            </div>

            {problem ? <Note tone={problem.tone === "red" ? "red" : "gold"} icon="warning" role="alert">{problem.text}</Note> : null}
            {blocked ? <p style={{ margin: 0, fontSize: 14, lineHeight: "19px", fontWeight: 600, textAlign: "center", color: colors.gold }}>{blocked}</p> : null}
            <PrimaryButton size="lg" fullWidth label="Import events" onPress={() => void importEvents()} disabled={loading || blocked !== null} loading={loading} ariaLabel={blocked ? `Import events. ${blocked}` : "Import events"} />
          </>
        )}
      </SheetBody>
    </Sheet>
  );
}

