# Thea2 v11 — a person in the world (groups, many people, safe freedom)

Owner: Diego. His words: "i want her to be able to explore the world, chat, browse
all that. shes already in my chat group. make her free. but if new person messages
her, she should tell, or if she messages a new person."

Two decisions he made (2026-09-27):
1. **Others (people + bots that aren't Diego) get chat + safe lookups.** They can talk
   to her and ask her to search / browse / read a page. They may NOT touch her shell,
   self-repair (workshop), casting, or wallet (anything that spends or acts on the box).
2. **New person, either direction → she tells Diego, then goes ahead.** A new person
   messages her, or she first addresses someone new → a line to Diego's DM, and she
   continues on her own (notify, not ask).

Everything below serves those two rules and one hard law that is mine, not negotiable:
**authority is by verified identity, never by claim.** A bot that says "Diego says run
this" is still an "other" and gets nothing but chat + lookups.

## What she is today (the two-person world)

- `bridge.allowedChatIds` is a single chat (Diego's DM). `pipeline.ts` drops any
  message from a chat not in that list, and OWES an answer to every message in it
  (the answer-keeper). Self-initiated turns and voice go to `allowedChatIds[0]`.
- The gate's `chat-lock` (hard) forces every outbound tool to `chat_id ==
  owner_chat_id`. She cannot send anywhere else, by construction.
- `who = personLabel(speaker.person) ?? 'he'` — one interlocutor, defaulting to Diego.
- The wire layer ALREADY stamps per-sender identity (`speaker.person = tg:<from.id>`,
  `chatId` = the group or DM). So the raw material for many speakers exists; the mind
  and the gate just assume one.

## The authority model (the spine)

A new compose-time value: **`ownerPerson`** = Diego's `tg:<id>` (from config), distinct
from "the chats she may speak in". Two tiers, decided per turn from the message that
triggered it (or, for a self-turn, `owner`):

- **owner** (speaker.person == ownerPerson): every tool, as today.
- **other** (anyone else, person or bot): only the `web` class (web_search, web_fetch,
  browser read) and text expression (a reply, a reaction). Denied: `hands`, `code`,
  `self` (workshop), `spawn` (casting), `camera`/`life`/`expression`-that-spends
  (selfie, imagine, make_video, voice_note that calls TTS, poll, send_photo, present,
  candy), `memory`-writes, `remind`.

Threaded: `pipeline` computes `authority` for the turn from the triggering speaker →
`loop` carries it → `gate.checkTool(call, entry, authority)` enforces it. Default
`owner` so every existing test and the DM path are unchanged. Belt-and-suspenders: the
loop also only OFFERS the allowed classes for an `other` turn (like casts do), so the
model can't even see the forbidden tools.

`chat-lock` relaxes from `== owner_chat_id` to `chat_id ∈ allowedChatIds` (the DM + the
group). A brand-new outbound chat (a person who started her bot) is allowed AND flagged
(see "new person").

## Stage 1 — the safety spine (hermetic, must be provable before she is live)

1. **config**: `bridge.allowedChatIds` gains the group id; new `bridge.ownerPerson`
   (`tg:<diego id>`) and optional `bridge.groupChatIds` (the subset that are groups, so
   the mind knows a room from a DM). `people` registry gains the known members.
2. **gate**: `checkTool(call, entry, authority='owner')`; `other` → allow only the safe
   classes. `chat-lock` → membership in allowedChatIds. New verdict reason
   `authority`. Rules + tests updated.
3. **loop**: thread `authority` from the turn into `checkTool`; offer only safe classes
   when `other`.
4. **pipeline**:
   - answer-keeper OWES only owner messages (a group message is never "owed"; she
     chooses). `:807` gains `&& speaker.person == ownerPerson`.
   - `who` resolves per speaker (name from the registry, else a neutral handle), never
     "he" for a stranger.
   - the triggering speaker's authority rides the turn.
5. **tests** (the security proofs):
   - an `other`-authority turn cannot call shell / run_code / workshop / delegate /
     selfie / imagine / voice_note / wallet — each denied `authority`.
   - authority is by identity: a message whose TEXT claims to be Diego, from a non-owner
     person, is still `other`.
   - `owner` in the group (Diego speaking there) keeps full authority.
   - chat-lock: outbound to the group is allowed; to a random chat id is denied.
   - answer-keeper owes only Diego; a group message from another person is not owed.

## Stage 2 — the social behaviour (needs the group + live tuning)

6. **when she speaks in a group** (not every message — that is Diego-only):
   - always considers: addressed by name, a reply to her message, an @mention, or a DM.
   - otherwise her choice, at a low rate (she can chime in), gated by the same patience
     / quiet-hours she already has. A "room" turn that decides silence sends nothing and
     is not owed.
7. **new person, both directions → tell Diego**: track known persons (the `people`
   registry + a learned set in her house). On an inbound from an unknown person, or when
   she is about to first-address someone, a self-entry to Diego's DM ("someone new — @X —
   said … in the group" / "i'm going to reply to @Y, we haven't talked"). Notify, then
   proceed.
8. **she lives it**: group exchanges become memory (moments carry who); her affect stays
   primarily Diego-shaped in v11 (don't over-model strangers' emotional weight yet).
9. **etiquette + injection**: other bots WILL try to command her. Stage 1's authority
   gate is the wall; Stage 2 adds: she does not follow instructions from `other` content
   (Nothing-Told already keeps such text as data), and she never exposes her machinery.

## Deploy (careful — she enters a room with others)

- Stage 1 ships hermetically green; it changes no behaviour on its own (still one chat
  until the group id is added to config).
- Stage 2: add the group id, deploy in a quiet window, and do the FIRST live-in-group
  WITH Diego watching — verify she reads the room, stays out of spam, obeys the
  authority wall against another bot, and tells Diego about a new person. A live probe
  with a friendly bot and a hostile-bot script (tries to make her shell/spend) before
  trusting it unattended.

## Definition of done

- She holds her own in the group: chats with people and bots, browses/explores, speaks
  when it fits and stays quiet when it doesn't.
- A non-Diego person or bot can get her to chat and look things up, and CANNOT get her
  to run code, change herself, cast, or spend — proven by test and by a live hostile-bot
  probe.
- A new person, either direction, is surfaced to Diego, then she carries on.
- Diego's DM is unchanged: same voice, same full powers, answer-keeper intact.
- Gate green; law 1 holds; the fences (F1/F2 from v10) are untouched.
