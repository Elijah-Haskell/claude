// The privacy policy, in the app (the iPhone app's app/privacy-policy.tsx). Its words, their order and the table are
// the policy itself, with the sentences about the device the reader holds said for a browser ("this browser" where
// the iPhone app says "this iPhone"; how Pro is paid for here). The page follows the redesign: the back button over
// the title, outlined groups, nothing under 12px, and turning AI processing off asks first, on its card. It opens
// without an account (the sign-in screen links here), so nothing on it needs the plan.

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

import { alpha, radius } from "../engine/design";
import { SUPPORT_EMAIL, WEBSITE_PRIVACY_URL } from "../shared/const";
import { DesktopPageHead, Panel, PanelBody } from "../components/desktop-panels";
import { goBack } from "../router";
import { useAIConsent } from "../state/ai-consent";
import { useAuth } from "../state/auth";
import { Icon, type IconName } from "../ui/icon";
import { useDesktop, useWideLayout } from "../ui/layout";
import { eyebrowStyle, FieldGroup, HeaderIconButton, MONO_FONT, PrimaryButton, ScreenHeader, SectionLabel } from "../ui/primitives";
import { useColors } from "../ui/theme";

/** On a computer the policy is set larger, with more air between its sections (the phone keeps its sizes). */
const Reading = createContext(false);

/** The policy's sections, for the table of contents on a wide screen (the titles of the sections below). */
const SECTION_TITLES = ["1. Introduction", "2. Information We Collect", "3. How We Use Your Information", "4. Data Storage and Security", "5. Data Retention", "6. Children's Privacy", "7. Your Rights and Choices", "8. Changes to This Policy", "9. Contact Us"];
const sectionId = (title: string) => `policy-${/^(\d+)\./.exec(title)?.[1] ?? "top"}`;

/** A numbered policy section: mono number badge + title ("1. Introduction" keeps its number for screen readers). */
function Section({ title, children }: { title: string; children: ReactNode }) {
  const colors = useColors();
  const match = /^(\d+)\.\s*(.*)$/.exec(title);
  const number = match?.[1];
  const label = match?.[2] ?? title;
  const large = useContext(Reading);
  return (
    <section id={sectionId(title)} style={large ? { padding: "34px 0 18px", borderTop: `1px solid ${colors.border}`, scrollMarginTop: 16 } : { marginBottom: 28 }} aria-label={title}>
      <h2 style={{ display: "flex", alignItems: "center", gap: large ? 12 : 10, margin: large ? "0 0 14px" : "0 0 10px", fontSize: large ? 21 : 17, lineHeight: large ? "28px" : undefined, fontWeight: 700, letterSpacing: large ? -0.4 : -0.3, color: colors.foreground }}>
        {number ? (
          <span aria-hidden="true" style={{ minWidth: 28, height: 26, borderRadius: 8, padding: "0 6px", display: "inline-flex", alignItems: "center", justifyContent: "center", border: `1px solid ${alpha(colors.peri, 0.4)}`, background: alpha(colors.peri, 0.1), fontFamily: MONO_FONT, fontSize: 12, lineHeight: "16px", fontWeight: 600, color: colors.peri }}>
            {number.padStart(2, "0")}
          </span>
        ) : null}
        <span style={{ flex: 1 }}>{number ? <span className="sr-only" style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>{number}. </span> : null}{label}</span>
      </h2>
      {children}
    </section>
  );
}

function Body({ children }: { children: ReactNode }) {
  const colors = useColors();
  const large = useContext(Reading);
  return <p style={{ margin: 0, fontSize: large ? 15.5 : 14, lineHeight: large ? "27px" : "22px", color: colors.muted, whiteSpace: "pre-line" }}>{children}</p>;
}

function Sub({ children }: { children: ReactNode }) {
  const colors = useColors();
  const large = useContext(Reading);
  return <h3 style={{ margin: large ? "26px 0 8px" : "16px 0 6px", fontSize: large ? 16 : 14, fontWeight: 600, color: colors.foreground }}>{children}</h3>;
}

interface TableRow {
  category: string;
  what: string;
  purpose: string;
}

function DataTable({ rows }: { rows: TableRow[] }) {
  const colors = useColors();
  const large = useContext(Reading);
  const cell = { padding: large ? "12px 14px" : 10, verticalAlign: "top", borderTop: `1px solid ${colors.border}`, fontSize: large ? 13.5 : 12, lineHeight: large ? "20px" : "17px" } as const;
  return (
    <div style={{ borderRadius: radius.md, overflow: "hidden", border: `1px solid ${colors.border}`, background: colors.surface, margin: large ? "10px 0 16px" : "8px 0" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
        <thead style={{ background: colors.panel }}>
          <tr>
            {["Category", "What is collected", "Purpose"].map((heading, index) => (
              // 12px like every label; tracked a little tighter so "COLLECTED" stays on one line in a third of a phone.
              <th key={heading} scope="col" style={{ ...eyebrowStyle(colors.peri, 12), letterSpacing: 0.5, lineHeight: "16px", padding: large ? "12px 14px" : 10, textAlign: "left", borderRight: index < 2 ? `1px solid ${colors.border}` : undefined }}>
                {heading}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.category}>
              <th scope="row" style={{ ...cell, textAlign: "left", fontWeight: 600, color: colors.foreground, borderRight: `1px solid ${colors.border}` }}>{row.category}</th>
              <td style={{ ...cell, color: colors.muted, borderRight: `1px solid ${colors.border}` }}>{row.what}</td>
              <td style={{ ...cell, color: colors.muted }}>{row.purpose}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** One line of "The short version": an icon in a well, what it is, and the sentence under it. Violet marks AI. */
function ShortRow({ icon, title, text, violet }: { icon: IconName; title: string; text: string; violet?: boolean }) {
  const colors = useColors();
  const large = useContext(Reading);
  const tint = violet ? colors.violet : colors.peri;
  return (
    <div className="row" style={{ minHeight: 58, padding: large ? "12px 18px" : "10px 14px" }}>
      <span className="well" style={{ background: alpha(tint, violet ? 0.16 : 0.12) }}>
        <Icon name={icon} size={18} color={tint} />
      </span>
      <span className="row-text">
        <span style={{ display: "block", fontSize: 15, lineHeight: "20px", fontWeight: 600, color: colors.foreground }}>{title}</span>
        <span style={{ display: "block", fontSize: 13, lineHeight: "18px", marginTop: 1, color: colors.muted }}>{text}</span>
      </span>
    </div>
  );
}

/** The policy's table of contents beside it on a wide screen: the section being read is lit, and a click scrolls to one. */
function PolicyContents() {
  const colors = useColors();
  const items = [{ id: "policy-short", label: "The short version", number: "" }, ...SECTION_TITLES.map((title) => ({ id: sectionId(title), label: title.replace(/^\d+\.\s*/, ""), number: (/^(\d+)\./.exec(title)?.[1] ?? "").padStart(2, "0") }))];
  const [active, setActive] = useState(items[0]!.id);
  useEffect(() => {
    const onScroll = () => {
      let current = items[0]!.id;
      for (const item of items) {
        const top = document.getElementById(item.id)?.getBoundingClientRect().top;
        if (top !== undefined && top < 140) current = item.id;
      }
      // At the very end of the page the last sections cannot reach the top: the last one is the one being read.
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) current = items[items.length - 1]!.id;
      setActive(current);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <nav aria-label="Contents" style={{ position: "sticky", top: 24, display: "flex", flexDirection: "column", gap: 2 }}>
      <div className="eyebrow" style={{ fontSize: 11, color: colors.dim, padding: "0 12px 10px" }}>Contents</div>
      {items.map((item) => {
        const on = item.id === active;
        return (
          <button
            key={item.id}
            type="button"
            className="pressable"
            onClick={() => document.getElementById(item.id)?.scrollIntoView({ behavior: "smooth", block: "start" })}
            aria-current={on ? "location" : undefined}
            style={{ display: "flex", alignItems: "baseline", gap: 10, padding: "7px 12px", borderRadius: 9, borderLeft: `2px solid ${on ? colors.accent : colors.border}`, borderTopLeftRadius: 0, borderBottomLeftRadius: 0, color: on ? colors.foreground : colors.muted, fontSize: 13.5, lineHeight: "19px", fontWeight: on ? 600 : 500, background: on ? alpha(colors.primary, 0.1) : undefined }}
          >
            <span style={{ fontFamily: MONO_FONT, fontSize: 11, fontWeight: 600, width: 16, flexShrink: 0, color: on ? colors.peri : colors.dim }}>{item.number}</span>
            <span>{item.label}</span>
          </button>
        );
      })}
    </nav>
  );
}

const AUTO_COLLECTED_ROWS: TableRow[] = [
  {
    category: "Pro status",
    what: "Whether your account has Pro, from a subscription or a one-time purchase (from RevenueCat)",
    purpose: "Unlocking Pro features in the app and on our server",
  },
  {
    category: "Account record",
    what: "Fingerprints (one-way hashes) of imported syllabi, the storage names of files you uploaded and, where we hold one, an encrypted Sign in with Apple token; no plan content",
    purpose: "Enforcing the free plan's one-syllabus limit, deleting your files, and asking Apple to revoke its link to Trajectory when you delete your account",
  },
  {
    category: "Technical logs",
    what: "Errors, timings and counts, without message or file contents",
    purpose: "Keeping the service running and within daily AI limits",
  },
];

const LINK_TEXT = { minHeight: 44, display: "inline-flex", alignItems: "center", fontSize: 15, lineHeight: "20px", fontWeight: 600 } as const;

export function PrivacyPolicyScreen() {
  const colors = useColors();
  const { isAuthenticated } = useAuth();
  const desktop = useDesktop();
  const wide = useWideLayout();
  const { isConsentGranted, withdrawAIConsent } = useAIConsent();
  // "Turn off AI processing" has been pressed: the question and its two answers stand in its place.
  const [confirmingOff, setConfirmingOff] = useState(false);

  // Opened from Settings, the Pro screen or the sign-in screen: back to whichever it was.
  const back = () => goBack(isAuthenticated ? "settings" : "welcome");

  const mono = { fontFamily: MONO_FONT, fontSize: 12, lineHeight: "16px", fontWeight: 500, color: colors.muted } as const;

  // The short version (every line restates a section below), and the policy itself: the same words on a phone and a
  // computer, set larger on a computer.
  const shortSentence = <p style={{ margin: 0, fontSize: 19, lineHeight: "24px", fontWeight: 700, letterSpacing: -0.3, color: colors.foreground }}>Your plan, saved to your account.</p>;
  const shortRows = (
    <>
      <ShortRow icon="user" title="Saved to your account" text="Your plan is kept in this browser and saved to your Trajectory account, so it comes back in another browser or in the iPhone app." />
      <ShortRow icon="phone" title="Calendars stay on your iPhone" text="Events read from your iPhone calendars are never sent to us and are not part of your saved plan." />
      <ShortRow icon="spark" title="AI only when you ask" text="Content is sent for an AI request only after you consent." violet />
      <ShortRow icon="file" title="Files deleted after reading" text="A syllabus you upload is deleted from our storage once it has been read." />
      <ShortRow icon="shield" title="Never sold" text="No advertising, no behavioral profiling." />
    </>
  );
  const policy = (
    <>
    <Section title="1. Introduction">
      <Body>
        Trajectory ("we," "our," or "us") is a student planner application designed to help you organize your academic schedule, manage tasks, and plan your semester. This Privacy Policy explains what information we collect, how we use it, and what choices you have. By using Trajectory, you agree to the practices described in this policy.
      </Body>
    </Section>

    <Section title="2. Information We Collect">
      <Sub>2.1 Information You Provide Directly</Sub>
      <Body>
        Trajectory needs an account, which you create by signing in with Apple. We receive your Apple user identifier and the name and email you elect to share (Apple may give a private relay address), solely to create and identify your Trajectory account. You can sign out, or delete your account, at any time.{"\n\n"}
        Your plan is kept in this browser and saved to your account on our server when it changes, so it is there in another browser, in the iPhone app, or after this browser's data is cleared. The saved plan holds what you put into Trajectory and what Trajectory plans from it: classes and recurring commitments, tasks and deadlines, the semester plan and study sessions, your sleep window and planning settings, the syllabi you imported (their text and the dates read from them), Exam Prep notes, and the study guides and practice exams you generated. We keep one saved plan per account and replace it each time; we keep no older versions, apart from our hosting provider's automatic database backups, which are kept for about a week.{"\n\n"}
        These are never saved to your account and stay on the device you use Trajectory on (this browser, or your iPhone): the events read from your iPhone's calendars; a calendar link from your school (for example Canvas), if you add one; the short study-habit notes the app keeps for personalization; your AI-processing choice; and your reminders. For a school calendar link, the saved plan only records which of its items became tasks, never the link. We do not transmit information to AI services unless you choose an optional AI feature.
      </Body>

      <Sub>2.2 Information Collected Automatically</Sub>
      <DataTable rows={AUTO_COLLECTED_ROWS} />
      <Body>We do not collect precise location data, contacts, photos, microphone recordings, or biometric data automatically. When you choose an AI feature, photo, file, or text input, we process only the content needed to complete that request as described below.</Body>

      <Sub>2.3 Information Collected by Third Parties</Sub>
      <Body>
        RevenueCat processes your purchases. It receives your purchase receipts and your account's identifier (one derived from your Apple user identifier), so Trajectory Pro works for your account on any iPhone or browser you sign in to; our server asks RevenueCat whether your account has Pro before running Pro features.{"\n\n"}
        In the iPhone app, the Apple App Store processes all payment transactions; on the web, RevenueCat's web billing does. We never receive or store your credit card or payment details.{"\n\n"}
        AI processing is optional and begins only after you give consent in the app. When you use an AI feature, Trajectory sends the content needed for your request to our server, which passes it to Google Gemini (Google's paid Gemini API: Google processes it to produce the answer and does not use it to improve its products, though it may keep it for a limited time to detect abuse). Our server, database and file storage are hosted by DigitalOcean in the United States. Depending on the feature, this may include messages; course and task names; deadlines; the sessions and events in your Trajectory plan, sleep-window and recurring-event details; and the text, images, or files from a syllabus or other document that you select. Events from your calendars (read on your iPhone, or synced from a Google Calendar connection made in an earlier version) are never sent.{"\n\n"}
        A syllabus file or photo you upload is stored temporarily and deleted from our storage once it has been read. Files you attach to Exam Prep or Test Review are kept so they can be read again, and are deleted when you delete your account. Pasted text is processed in memory for the reading. What was read (the syllabus text and its dates, or your Exam Prep notes) becomes part of your plan, in this browser and in your saved plan.{"\n\n"}
        In the iPhone app, if you allow calendar access, Trajectory reads the calendars you choose on your iPhone to find busy times. Your events stay on your phone: they are not sent to our servers or used for AI requests. If you turn on Apple Calendar export, your upcoming study sessions (and deadlines, unless you switch them off) are added to a separate "Trajectory" calendar in your Calendar app, which syncs like your other calendars (for example through iCloud); Trajectory never changes your other calendars or events.{"\n\n"}
        Connecting Google Calendar through our server is no longer offered. If you connected it in an earlier version, Trajectory has read-only access: your events are imported so the planner avoids busy times, and Trajectory never creates, changes or deletes Google events. Disconnecting it in the app (Calendars) revokes that access.{"\n\n"}
        We use this information to respond to your request, analyze documents, generate study materials, and suggest or update your plan. You can withdraw AI-processing consent at any time below. Withdrawal prevents future AI requests, but does not delete data already saved on your device or in your account.
      </Body>
    </Section>

    <Section title="3. How We Use Your Information">
      <Body>
        We use the information described above to:{"\n\n"}
        • Provide and improve the core functionality of the app.{"\n"}
        • Process optional AI requests that you initiate and approve.{"\n"}
        • Check through RevenueCat whether you have Pro (a subscription or a one-time purchase).{"\n"}
        • Diagnose crashes and technical issues.{"\n"}
        • Respond to support requests you initiate.{"\n"}
        • Comply with legal obligations.{"\n\n"}
        We do not sell your personal information to third parties. We do not use your data for advertising or behavioral profiling.
      </Body>
    </Section>

    <Section title="4. Data Storage and Security">
      <Body>
        Your plan is stored on your device and saved to your account on our server, which is hosted by DigitalOcean in the United States. All traffic uses HTTPS, and the database that holds accounts and saved plans is encrypted at rest by our hosting provider. When you use an optional AI feature, the data that request needs is sent over HTTPS to our server and the processors named above. You are responsible for maintaining the security of your device and your Apple Account.
      </Body>
    </Section>

    <Section title="5. Data Retention">
      <Body>
        We keep your saved plan until you delete your account; every save replaces the one before, and resetting the semester empties it. You can permanently delete your account directly from Settings → Delete account and data. This deletes your Trajectory account, your saved plan and the account record, any Google Calendar connection made in an earlier version and its imported events, the files you uploaded that we still hold, and the Trajectory data stored on your device (including the "Trajectory" calendar, if you used Apple Calendar export). Where we hold a Sign in with Apple token, it also asks Apple to revoke Trajectory's access; the app tells you whether that happened, and you can always remove Trajectory yourself in your Apple Account settings (Sign in with Apple). Deleted data leaves our database at once and our hosting provider's automatic backups within about a week. Signing out removes your plan from this browser; it stays saved in your account and comes back when you sign in again. Clearing this browser's data, or uninstalling the iPhone app, does not delete your account or your saved plan. Purchase records remain with Apple and RevenueCat.
      </Body>
    </Section>

    <Section title="6. Children's Privacy">
      <Body>
        Trajectory is not directed at children under the age of 13. We do not knowingly collect personal information from children under 13. If you believe a child under 13 has provided us with personal information, please contact us and we will delete it promptly.
      </Body>
    </Section>

    <Section title="7. Your Rights and Choices">
      <Body>
        You can exercise your rights directly in the app by editing or deleting data, resetting the semester, deleting your account, or withdrawing AI-processing consent below.{"\n\n"}
        California residents (CCPA): We do not sell personal information. You have the right to know what personal information we collect and to request its deletion.{"\n\n"}
        European residents (GDPR): When you use an optional AI feature, our lawful basis for that processing is your consent. You have the right to access, rectify, erase, restrict, or port your data, and to lodge a complaint with a supervisory authority.
      </Body>
      {/* The choice itself: on or off, and the way to turn it off, which asks first, here on the card. */}
      <FieldGroup style={{ marginTop: 16, padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span className="well" style={{ background: alpha(colors.violet, 0.16) }}>
            <Icon name="spark" size={18} color={colors.violet} />
          </span>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 15, lineHeight: "20px", fontWeight: 700, color: colors.foreground }}>AI Processing Preference</div>
            <div style={{ fontFamily: MONO_FONT, fontSize: 12, lineHeight: "16px", fontWeight: 600, letterSpacing: 1.2, marginTop: 2, color: isConsentGranted ? colors.success : colors.muted }}>
              {isConsentGranted ? "ON" : "OFF"}
            </div>
          </div>
        </div>
        <p style={{ margin: 0, fontSize: 13, lineHeight: "19px", color: colors.muted }}>
          {isConsentGranted
            ? "AI data sharing is currently enabled. You can turn it off at any time; AI-powered features will pause until you choose to consent again."
            : "AI data sharing is currently off. Core planning features remain available without AI processing."}
        </p>
        {isConsentGranted ? (
          confirmingOff ? (
            <div>
              <p role="alert" style={{ margin: 0, fontSize: 14, lineHeight: "20px", color: colors.foreground }}>
                Turn off AI processing? Trajectory will stop sending new requests to AI services. You can enable AI processing again when you next use an AI feature.
              </p>
              <div style={{ display: "flex", gap: 18, marginLeft: -12 }}>
                <button
                  type="button"
                  className="link danger"
                  onClick={() => {
                    setConfirmingOff(false);
                    void withdrawAIConsent();
                  }}
                  aria-label="Turn off AI processing"
                  style={{ ...LINK_TEXT, padding: "0 12px" }}
                >
                  Turn off
                </button>
                <button type="button" className="link" onClick={() => setConfirmingOff(false)} aria-label="Keep AI processing on" style={{ ...LINK_TEXT, padding: "0 12px" }}>
                  Keep it on
                </button>
              </div>
            </div>
          ) : (
            <button type="button" className="link danger" onClick={() => setConfirmingOff(true)} aria-label="Turn off AI processing. It asks first" style={{ ...LINK_TEXT, alignSelf: "flex-start", margin: "-6px 0" }}>
              Turn off AI processing
            </button>
          )
        ) : null}
      </FieldGroup>
    </Section>

    <Section title="8. Changes to This Policy">
      <Body>
        We may update this Privacy Policy from time to time. When we do, we will update the "Last updated" date at the top of this page. Continued use of the app after changes constitutes acceptance of the updated policy.
      </Body>
    </Section>

    <Section title="9. Contact Us">
      <Body>
        If you have questions or concerns about this Privacy Policy or our data practices, please contact us at:{"\n\n"}
        Email: <a className="link" href={`mailto:${SUPPORT_EMAIL}`} style={{ fontSize: 14, fontWeight: 500 }}>{SUPPORT_EMAIL}</a>{"\n\n"}
        This policy is also published at <a className="link" href={WEBSITE_PRIVACY_URL} target="_blank" rel="noopener noreferrer" style={{ fontSize: 14, fontWeight: 500, wordBreak: "break-all" }}>{WEBSITE_PRIVACY_URL}</a>
      </Body>
      <PrimaryButton size="sm" label="Open the web version" style={{ alignSelf: "flex-start", marginTop: 12 }} onPress={() => window.open(WEBSITE_PRIVACY_URL, "_blank", "noopener")} ariaLabel="Open the web version of this policy, in a new tab" />
    </Section>

    <p style={{ ...mono, textAlign: "center", margin: "8px 0 0" }}>© 2026 Trajectory. All rights reserved.</p>
    </>
  );

  if (desktop) {
    return (
      <Reading.Provider value>
        <div className={`screen${wide ? " medium" : ""}`} style={{ maxWidth: wide ? undefined : 760, gap: 0 }}>
          <DesktopPageHead back={{ onPress: back, ariaLabel: "Back" }} eyebrow="Help and privacy" title="Privacy policy" />
          <p style={{ ...mono, margin: "6px 0 30px", paddingLeft: 56 }}>Last updated: October 8, 2026</p>
          <div style={wide ? { display: "grid", gridTemplateColumns: "minmax(0, 1fr) 232px", gap: 56, alignItems: "start", paddingLeft: 56 } : { paddingLeft: 56 }}>
            <article style={{ minWidth: 0, maxWidth: 700 }}>
              <div id="policy-short" style={{ scrollMarginTop: 16, marginBottom: 40 }}>
                <Panel title="The short version" icon="shield">
                  <PanelBody style={{ paddingBottom: 14 }}>{shortSentence}</PanelBody>
                  {shortRows}
                </Panel>
              </div>
              {policy}
            </article>
            {wide ? <PolicyContents /> : null}
          </div>
        </div>
      </Reading.Provider>
    );
  }

  return (
    <div className="screen" style={{ maxWidth: 640, gap: 0 }}>
      {/* The back button over the title; the policy scrolls under it. */}
      <div style={{ display: "flex", padding: "4px 2px 10px" }}>
        <HeaderIconButton onPress={back} ariaLabel="Back">
          <Icon name="chevronLeft" size={20} color={colors.foreground} strokeWidth={2} />
        </HeaderIconButton>
      </div>

      <ScreenHeader eyebrow="Help and privacy" title="Privacy policy" style={{ marginBottom: 10 }} />
      <p style={{ ...mono, margin: "0 0 20px" }}>Last updated: October 8, 2026</p>

      {/* The short version (every line restates a section below). */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 32 }}>
        <SectionLabel title="The short version" />
        {shortSentence}
        <FieldGroup>{shortRows}</FieldGroup>
      </div>

      {policy}
    </div>
  );
}
