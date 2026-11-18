# Email

Lawdesk sends notices and client email, and files emails to matters.

| File | What it does |
| --- | --- |
| `mime.ts` | Builds messages (RFC 5322 / 2045 / 2046 / 2047 / 2231): text + HTML, attachments, encoded headers, Date, Message-ID. |
| `parse.ts` | Reads saved `.eml` files: headers, multipart bodies, quoted-printable / base64, UTF-8 / Latin-1 / Windows-1252, attachments. |
| `smtp.ts` | Minimal SMTP client (RFC 5321): implicit TLS or STARTTLS, AUTH PLAIN / LOGIN / XOAUTH2. |
| `transport.ts` | `Transport` interface: `DevTransport` (writes `.eml` files) and `SmtpTransport`; `TokenProvider` for OAuth. |
| `settings.ts` | Firm settings in `email_settings`, overridable by environment variables. |
| `outbox.ts` | The queue: every message is stored, then sent with retries (1, 5, 15, 60, 240 minutes; 6 tries). |
| `notify.ts` | Task-assigned emails, the daily summary, calendar reminders, `sendPasswordReset(db, email, link)`. |
| `comms.ts` | A matter's communication log, sending from a matter with templates, filing `.eml` files. |
| `worker.ts` | The once-a-minute background job the server starts (`LAWDESK_EMAIL_WORKER=0` turns it off). |

## Settings

Out of the box nothing is sent: every message is written as a `.eml` file to `LAWDESK_MAIL_DIR`
(default `./mail-out`). To send for real, open **Settings > Email**, choose "Send through the firm's
mail server", fill in the server, and use **Send test email**.

Any field can instead be fixed on the server with an environment variable (the screen then shows it
read-only): `LAWDESK_MAIL_TRANSPORT` (`dev` or `smtp`), `LAWDESK_SMTP_HOST`, `LAWDESK_SMTP_PORT`,
`LAWDESK_SMTP_SECURITY` (`starttls`, `tls` or `none`), `LAWDESK_SMTP_USER`, `LAWDESK_SMTP_PASSWORD`,
`LAWDESK_SMTP_AUTH` (`auto`, `plain`, `login`), `LAWDESK_MAIL_FROM`, `LAWDESK_MAIL_FROM_NAME`,
`LAWDESK_APP_URL` (used for links in emails).

The password is never returned by the API or written to logs. Prefer `LAWDESK_SMTP_PASSWORD`. If it
is typed into the screen it is stored in the database; set `LAWDESK_SECRET_KEY` and it is encrypted
there with AES-256-GCM.

A password is only ever sent over an encrypted connection (STARTTLS is required, never optional,
when chosen), except to a mail server on the same machine.

## Gmail / Google Workspace and Microsoft 365

Both accept ordinary SMTP on port 587 with STARTTLS (the "Fill in the usual settings" buttons on the
screen). How you sign in depends on the account:

- **App password** (simplest, works today): with 2-Step Verification on, create an app password and
  use it as the SMTP password. Google: <https://support.google.com/accounts/answer/185833>.
  Microsoft 365 only allows SMTP sign-in with a password if the tenant still has "SMTP AUTH" enabled
  for the mailbox: <https://learn.microsoft.com/en-us/exchange/clients-and-mobile-in-exchange-online/authenticated-client-smtp-submission>.
- **OAuth 2.0 (XOAUTH2)**: the code is ready (`xoauth2String` in `smtp.ts`, `RefreshTokenProvider`
  and `SmtpTransport(opts, tokenProvider)` in `transport.ts`), but it needs an OAuth app registered by
  the firm's administrator, which cannot be done from here. Steps:

  **Google**
  1. In Google Cloud Console create a project and an OAuth client ID of type "Web application"
     (<https://developers.google.com/identity/protocols/oauth2/web-server#creatingcred>).
  2. Configure the OAuth consent screen as *Internal* (Workspace) and add the scope
     `https://mail.google.com/` (<https://developers.google.com/gmail/imap/xoauth2-protocol>).
  3. Sign in once as the sending mailbox with `access_type=offline` to get a refresh token
     (<https://developers.google.com/identity/protocols/oauth2/web-server#offline>).
  4. Token endpoint: `https://oauth2.googleapis.com/token`.

  **Microsoft 365**
  1. In Microsoft Entra admin center, register an application
     (<https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app>).
  2. Add the delegated permission `SMTP.Send` (Office 365 Exchange Online) and `offline_access`, and
     grant admin consent
     (<https://learn.microsoft.com/en-us/exchange/client-developer/legacy-protocols/how-to-authenticate-an-imap-pop-smtp-application-by-using-oauth>).
  3. Make sure "Authenticated SMTP" is enabled for the sending mailbox (link above).
  4. Get a refresh token with the authorization-code flow; scope
     `https://outlook.office.com/SMTP.Send offline_access`. Token endpoint:
     `https://login.microsoftonline.com/<tenant-id>/oauth2/v2.0/token`
     (<https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow>).

  Still to build: a "Connect Google / Microsoft" button that runs step 3 in the browser and stores
  the refresh token (encrypted, like the password), and a settings choice that uses
  `RefreshTokenProvider` instead of a password.

## Notices

- **New task**: when a task is assigned to someone other than the person who assigned it. Several at
  once (a checklist) become one email. The first run after install records existing assignments
  without emailing.
- **Daily summary**: overdue tasks and tasks due today, at each person's chosen time (America/Chicago),
  weekdays unless they ask for weekends. Nothing is sent on a day with nothing due.
- **Calendar reminders**: from the calendar's `remindersDue`; each (event, occurrence, reminder,
  person) is recorded in `email_reminders_sent`, so nothing repeats even if the job runs twice. A
  server that was off catches up at most 24 hours.
- **Password reset**: `sendPasswordReset(db, email, link)` for the sign-in module. The message is marked
  sensitive: its subject is hidden in the outbox list and its contents are deleted once sent.

## Communications on a matter

The matter page's **Communications** card shows emails sent from Lawdesk, emails filed to the matter,
and calls, meetings and notes logged by hand.

- **Write an email**: to the matter's client or any contact with an address (or typed addresses),
  optionally from a template. Templates use the same merge fields as document templates
  (`{{client.name}}`, `{{matter.number}}`, ...) plus `{{recipient.name}}`. A field that does not exist
  stops the send; a field with no value asks first. Replies go to the sender's own address
  (Reply-To). Matter documents can be attached.
- **File a saved email**: drag a `.eml` onto the card. The original goes into the matter's Documents
  (folder "Correspondence") with each attachment; an attachment whose contents don't match its name
  is left out (it remains inside the saved `.eml`). The same Message-ID can't be filed twice.
- **Log a call or meeting**: when, length, who, notes. Making a time entry from it is left for
  billing: `LogInput.createTimeEntry` and `email_comm_log.time_entry_id` are the hook (TODO).

## Future work: a per-matter BCC address

Clio-style "BCC this address to file the email" needs Lawdesk to *receive* mail, which needs a mail
server. The plan:

1. Give the firm a subdomain for filing, e.g. `file.examplelaw.com`, with an MX record pointing at a
   receiving service (a small SMTP listener on the Lawdesk server, or an inbound-mail webhook from a
   provider such as Postmark, SendGrid or Mailgun).
2. Each matter gets an address `m-<matter id>-<random token>@file.examplelaw.com`. The random part
   (stored hashed, revocable per matter) stops strangers from guessing addresses and filing mail.
3. Incoming messages to that address are passed to `importEml` for that matter; anything to an
   unknown or revoked address is dropped and logged.
4. SPF/DKIM/DMARC results from the receiving server should be stored with each filed email.

Not built: it needs DNS and a public mail endpoint, which this install does not have.

## Known gaps

- International email addresses (SMTPUTF8, RFC 6531) are refused.
- No S/MIME or PGP; no read receipts.
- Inbound HTML is kept as text only (it is never rendered), so formatting in filed emails is lost.
- Outlook `.msg` files are not read; save as `.eml` first.
