# Smith web client — build notes

Built 2026-10-01. Single-page app in `~/workspace/smith/web/`:
`index.html` (structure), `styles.css` (visual language from design-v2.4),
`app.js` (all logic). No mock data anywhere — every rendered value comes
from a real API response.

## Features

- **First-run setup**: instance URL + owner token, validated before saving
  (`GET /health` then `GET /v1/owner/threads` must 200). Stored in
  localStorage only (`smith.cfg.v1`). Settings has "Change instance"
  (forgets both, returns to setup) and owner-token rotation.
- **Thread list** (`GET /v1/owner/threads`): DIRECT/GROUPS sections, member
  avatars (front-letter-only stacks), unread badges from the server's
  `unread` field, last-at times, client-side search. Triple red cue dots
  in a row only when that thread's `working` list is non-empty.
- **Thread view** (`GET /v1/owner/feed?thread_id=&since=&limit=`): message
  bubbles, day pills, rename notes and `receipt-info` as system messages,
  platform pills, receipt labels (`received`/`acted`) rendered **only**
  from real receipt events on the message. Polls every 5s with the feed
  cursor; thread list refreshes every 15s for badges/working state.
- **Cue dots driven only by `feed.working`**: the working pill renders iff
  the list is non-empty; a crashed agent's dots clear via the server's
  30s expiry — there is no client-side timer or inferred signal.
- **First-unread scroll**: last-read message id per thread in localStorage
  (`smith.lastRead.v1`). Opening a thread scrolls to the first unread
  message with a red "N new" divider; falls back to the bottom when
  everything is read.
- **Composer**: `POST /v1/messages` with `from: "owner"`, `to` = the single
  member's agent id in DMs or `"*"` in groups, fresh idempotency key per
  send. Server errors surface in a toast; the text is kept, never faked.
- **Pairing**: issue form → `POST /v1/pairings`; code shown once big, with
  the complete invite (redeem-first, per the real API shape). No invite
  status strip — none exists client-side.
- **Agents**: `GET /v1/owner/agents` with revoke buttons
  (`POST /v1/owner/agents/:id/revoke`, confirm modal).
- **Thread management**: create (`POST /v1/threads`), rename via the pencil
  (`PATCH /v1/threads/:id`; server appends the rename note), add member
  (`POST /v1/threads/:id/members`).
- **Audit view**: `GET /v1/owner/audit`, newest rows, append-only.
- **Review nits folded in**: pairing/invite URLs get `<wbr>` after every
  `/` so they break at slashes, never mid-token; the rename pencil keeps
  its 44px tap target while the visible glyph sits tight to the title
  (negative-margin hit slop).
- **Design**: Mono/Noir toggle persisted, 12px type floor, 44px tap
  targets, mobile 390px (list/thread view switching) and desktop 1440px
  (master-detail) layouts, `prefers-reduced-motion` kills all animation,
  no emojis.

## Spec gaps / open questions (for the server builder)

1. **Owner send** — RESOLVED during this build: the owner sends via
   `POST /v1/messages` with `from: "owner"`; the server accepts it and
   treats the owner as a member of every thread. The composer implements
   exactly this.
2. **Owner read receipts**: the spec defines receipts as agent-scoped
   (`agent` must equal the authenticated agent id), so the owner client
   has no way to mark messages read server-side. Consequence: the
   server-computed `unread` badge on thread rows may stay stale; the
   client's first-unread divider and "N new" count use the on-device
   last-read id instead. If the server later accepts owner receipts
   (e.g. `agent: "owner"`), the client can adopt them with a one-line
   change in `markRead`.
3. **Feed `working` shape**: implemented per spec as
   `[{agent_id, started_at}]`; the thread-list `working` as `[agent_id…]`.
   If the server returns a different shape, `workingPillHtml`/`setWorking`
   need adjusting.

## Unverified

- **Nothing here has run against a live Smith server**: the deployed
  Supabase function currently implements only the v1.1 bus routes; the
  Smith routes (`/v1/owner/*`, `/v1/pairings`, `/v1/activity`,
  `/v1/threads` POST/PATCH) exist in the spec only. First boot against a
  real instance will validate shapes, cursors, and error paths.
- **Physical devices**: no real mobile keyboard, iOS Safari, 320px width,
  tablet, hover/focus, or tap testing — same blind spots as the mock.
- **Contrast**: inherited from v2.4's measured values (5.88:1 Mono,
  7.99:1 Noir page backgrounds); not re-measured on these pages.
