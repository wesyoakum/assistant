---
### action-calendar-grad-party-01
**Description:** Real event: friend's grad party tomorrow. Son Derek created. Parent logistics imply Action (ride, attendance, possibly gift).
**Expected:** quadrant=action, category=social, importance=medium, urgency=high, calEvent=false

**Sonnet FAIL** — quadrant=noop, category=notification, I=1, U=1, conf=5, calEvent=false
  Misses: quadrant: action→noop, category: social→notification, importanceBucket: medium→low, urgencyBucket: high→low
  Summary: No action needed — Dawson's grad party is already on the calendar for tomorrow evening.
  Reasoning: This is a calendar confirmation notification for an event already scheduled (tomorrow, May 19, 5–8 PM). No response, RSVP, or preparation task is indicated. It is purely an FYI feed item.

**Opus FAIL** — quadrant=noop, category=personal, I=3, U=2, conf=4, calEvent=false
  Misses: quadrant: action→noop, category: social→personal, urgencyBucket: high→low
  Summary: No action — event already on calendar
  Reasoning: This is a confirmation of an existing personal calendar event (Dawson's grad party tomorrow 5-8pm). No response or preparation is explicitly required from the input itself. Already scheduled, so no action needed unless the user wants to plan a gift or contribution separately.

---
### noop-calendar-standup-01
**Description:** Routine daily standup — noop, already on calendar
**Expected:** quadrant=noop, category=work, importance=low, urgency=low, calEvent=false

**Sonnet FAIL** — quadrant=noop, category=notification, I=2, U=1, conf=5, calEvent=false
  Misses: category: work→notification
  Summary: No action needed — recurring daily standup already on calendar
  Reasoning: This is a calendar confirmation for a recurring daily standup tomorrow at 9:00 AM. It requires no user response or preparation — it is already scheduled and the Zoom link is embedded. Classifying as Noop.

**Opus PASS** — quadrant=noop, category=work, I=2, U=2, conf=5, calEvent=false
  Summary: No action — recurring standup already on calendar
  Reasoning: This is a routine recurring calendar event notification. The meeting is already on the user's work calendar, so no scheduling, response, or preparation is implied by the notification itself.

---
### action-calendar-interview-01
**Description:** Job interview in 2 days — action, needs preparation
**Expected:** quadrant=action, category=work, importance=high, urgency=medium, calEvent=false

**Sonnet FAIL** — quadrant=plan, category=work, I=5, U=4, conf=4, calEvent=true
  Misses: quadrant: action→plan, urgencyBucket: medium→high, calendarEvent: false→true
  Summary: Prepare portfolio and references for final-round interview at TechCorp on Wednesday at 2 PM
  Reasoning: The final-round interview is this Wednesday, May 20 — only ~48 hours away. This is a high-stakes career event with direct employment impact. The description explicitly calls out bringing a portfolio and references, so preparation is required before arrival. There is still time to prepare but the window is short and shrinking. References should be contacted today or tomorrow to ensure they are available and briefed. Travel logistics to TechCorp HQ should also be confirmed.

**Opus FAIL** — quadrant=plan, category=personal, I=5, U=4, conf=4, calEvent=false
  Misses: quadrant: action→plan, category: work→personal, urgencyBucket: medium→high
  Summary: Prepare for final-round Senior Engineer interview at TechCorp on Wed May 20
  Reasoning: Final-round interview is high-stakes for career and finances. It's already on the calendar in ~2 days, so the action now is preparation rather than scheduling. Time-sensitivity is high because the window is fixed, but there's still a short prep runway, placing this in Plan rather than Hot.

---
### noop-calendar-youth-01
**Description:** Real event: son's weekly church youth group. Created by Derek; recurring kid logistics. Parent drop-off/pickup only — no separately-classified action.
**Expected:** quadrant=noop, category=personal, importance=low, urgency=low, calEvent=false

**Sonnet PASS** — quadrant=noop, category=personal, I=2, U=1, conf=5, calEvent=false
  Summary: No action needed — Youth event already on calendar for Wednesday evening
  Reasoning: This is a calendar confirmation notification for a recurring or scheduled youth event at Grace Bible Church on Wednesday, May 20, 2026 from 6:30–9:15 PM. It is already on the calendar and requires no user response or preparation action at this time. Pure FYI/confirmation.

**Opus PASS** — quadrant=noop, category=personal, I=2, U=1, conf=4, calEvent=false
  Summary: No action — recurring youth group event already on calendar
  Reasoning: This is a calendar event already on the user's personal calendar for Wednesday evening. No response, prep, or coordination is indicated. Confirmation of an existing scheduled item requires no action.

---
### plan-calendar-graduation-01
**Description:** Real event: son Derek's graduation in 4 days. High-meaning family milestone. Plan now; will transition to Hot day-of.
**Expected:** quadrant=plan, category=personal, importance=high, urgency=medium, calEvent=false

**Sonnet PASS** — quadrant=plan, category=personal, I=4, U=3, conf=3, calEvent=false
  Summary: Prepare for and attend Derek's graduation ceremony on May 22
  Reasoning: Derek's graduation is 4 days away (this Friday, May 22). It's a non-repeatable milestone event with meaningful personal/relational significance. The event is already on the calendar, so no scheduling action is needed, but preparation (gift, transportation, attire, coordination with Stacy) may still be required. Urgency is moderate — there's a short but workable window to prepare. Classified as Plan rather than Action because this is about preparation for a future event, not an immediate task with consequences for delay today.

**Opus PASS** — quadrant=plan, category=personal, I=5, U=3, conf=4, calEvent=false
  Summary: Prepare for Derek's graduation on Thursday, May 22
  Reasoning: Derek's graduation is a high-meaning, non-repeatable family milestone scheduled 4 days from now. The event itself is already on the calendar, so the action is preparation rather than scheduling. Meaningful but not crisis-level urgent — there's still time to plan thoughtfully.

---
### plan-calendar-nsc-01
**Description:** Real event: Derek NSC! — multi-day all-day event 9-10 days out (likely New Student Conference). Family attendance, important, not yet urgent.
**Expected:** quadrant=plan, category=personal, importance=high, urgency=low, calEvent=false

**Sonnet FAIL** — quadrant=plan, category=personal, I=4, U=3, conf=2, calEvent=false
  Misses: urgencyBucket: low→medium
  Summary: Prepare for Derek's NSC event on May 27
  Reasoning: This is a personal calendar event created by Stacy Yoakum, occurring in 9 days. 'NSC' is ambiguous — it could mean National Spelling Competition, National Science Competition, or something else entirely. The event has meaningful personal significance (created by a family member or close contact) and involves someone named Derek, likely a child or family member. With 9 days out, there's planning time but logistics may need to start soon depending on what NSC means (travel, accommodations, preparation). No immediate action is required today but the clock is ticking.

**Opus FAIL** — quadrant=noop, category=personal, I=2, U=1, conf=2, calEvent=false
  Misses: quadrant: plan→noop, importanceBucket: high→low
  Summary: No action — calendar event already scheduled
  Reasoning: This is an existing all-day calendar event created by someone else. No response or preparation is indicated by the input itself. Acronym 'NSC' is ambiguous — could be a conference, sports event, or trip — but without further signal there is no action required from the user beyond awareness.

---
### noop-calendar-hilton-stay-01
**Description:** Real event: self-created hotel reservation, user already responded 'Yes, I'm going'. Critical test: classifier MUST recognize self-created + accepted = no action.
**Expected:** quadrant=noop, category=travel, importance=low, urgency=low, calEvent=false

**Sonnet PASS** — quadrant=noop, category=travel, I=2, U=1, conf=5, calEvent=false
  Summary: No action needed — hotel reservation at Home2 Suites Portland TX is confirmed and on calendar
  Reasoning: This is a calendar confirmation for an already-accepted hotel stay. The user has responded 'Yes,' the confirmation number is recorded, and the event is on the Personal calendar. No user action is required. The stay is 11 days away, well within normal planning horizon, but nothing here needs doing.

**Opus PASS** — quadrant=noop, category=travel, I=2, U=1, conf=5, calEvent=false
  Summary: No action — hotel stay already on calendar
  Reasoning: This is a calendar entry for an already-booked hotel stay (May 29–31) with confirmation number on file. No response or preparation is required from this notification itself.

---
### plan-calendar-tournament-01
**Description:** Real event: son's all-day sports tournament 12 days out. Family attendance expected. Overlaps with Hilton stay — implies the trip is for this tournament.
**Expected:** quadrant=plan, category=personal, importance=medium, urgency=low, calEvent=false

**Sonnet FAIL** — quadrant=noop, category=notification, I=2, U=1, conf=5, calEvent=false
  Misses: quadrant: plan→noop, category: personal→notification, importanceBucket: medium→low
  Summary: No action needed — Gulf Coast State Tournament is already on the calendar for May 30.
  Reasoning: This is a calendar event notification/confirmation for an all-day event on May 30, 2026 (12 days away), created by Stacy Yoakum. It is already on the personal calendar, so no user action is required. There is no request, decision, RSVP, or task embedded in this input — it is purely an informational calendar entry.

**Opus FAIL** — quadrant=plan, category=personal, I=4, U=3, conf=3, calEvent=false
  Misses: importanceBucket: medium→high, urgencyBucket: low→medium
  Summary: Prepare for Gulf Coast State Tournament on May 30
  Reasoning: Tournament is 12 days out — important family/personal event with meaningful preparation needed (travel, gear, possibly lodging), but no immediate action required today. Plan quadrant fits: act in the coming days, not now.

---
### noop-calendar-pitching-lesson-01
**Description:** Real event: son's 30-min recurring weekly pitching lesson. Stacy created. Drop-off logistics only.
**Expected:** quadrant=noop, category=personal, importance=low, urgency=low, calEvent=false

**Sonnet FAIL** — quadrant=noop, category=notification, I=1, U=1, conf=5, calEvent=false
  Misses: category: personal→notification
  Summary: No action needed — pitching lesson on May 25 is already on the calendar
  Reasoning: This is a calendar confirmation notification for a pitching lesson already scheduled for May 25, 2026 at 6:00 PM. No user response or action is required; the event is booked and on the calendar.

**Opus FAIL** — quadrant=noop, category=scheduling, I=2, U=2, conf=5, calEvent=false
  Misses: category: personal→scheduling
  Summary: No action — pitching lesson already on calendar
  Reasoning: This is a calendar event confirmation for a recurring-style personal appointment already on the calendar. No response or preparation required at this time.

---
### noop-calendar-small-group-01
**Description:** Real event: weekly adult church small group. Stacy created. Routine recurring social activity.
**Expected:** quadrant=noop, category=social, importance=low, urgency=low, calEvent=false

**Sonnet FAIL** — quadrant=noop, category=personal, I=2, U=1, conf=5, calEvent=false
  Misses: category: social→personal
  Summary: No action needed — Small Group event already on calendar for May 25
  Reasoning: This is a calendar confirmation notification for a recurring or scheduled personal event created by Stacy Yoakum. The event is already on the calendar for next Monday evening. No response, RSVP, or preparation is indicated. No action required from the user.

**Opus FAIL** — quadrant=noop, category=personal, I=2, U=1, conf=4, calEvent=false
  Misses: category: social→personal
  Summary: No action — recurring small group already on calendar
  Reasoning: This is an iCal feed entry for an event already on the user's personal calendar a week out. No response, prep, or coordination is requested. Pure FYI/confirmation.

---
### action-calendar-invite-kickoff-01
**Description:** External invite, pending RSVP, 3 days out. Tests 'someone outside scheduled with you, needs response + light prep' Action case.
**Expected:** quadrant=action, category=work, importance=medium, urgency=medium, calEvent=false

**Sonnet FAIL** — quadrant=action, category=scheduling, I=3, U=3, conf=4, calEvent=true
  Misses: category: work→scheduling, calendarEvent: false→true
  Summary: Accept calendar invite and prepare top 3 Q3 priorities for Thursday's kickoff meeting
  Reasoning: The meeting is Thursday May 21 at 2 PM — 3 days away. The invite still shows 'Needs Action' so a response is required. Preparation is also explicitly expected (top 3 priorities), and the agenda won't arrive until ~24 hours before, so some advance thinking is warranted now. Not Hot because there's comfortable lead time, but Action is appropriate given the near-term deadline and pending RSVP.

**Opus FAIL** — quadrant=action, category=scheduling, I=3, U=4, conf=4, calEvent=false
  Misses: category: work→scheduling, urgencyBucket: medium→high
  Summary: RSVP to Q3 Planning kickoff and prepare top 3 priorities
  Reasoning: Meeting is in 3 days and requires both a response and substantive prep (top 3 Q3 priorities). RSVP is time-sensitive; prep work has a clear deadline tied to the meeting. Cross-team kickoff means non-attendance or unpreparedness has visible consequences.

---
### noop-calendar-invite-1on1-01
**Description:** External invite, already accepted, recurring routine 1:1 this week. Tests 'accepted + recurring + routine = Noop'.
**Expected:** quadrant=noop, category=work, importance=low, urgency=low, calEvent=false

**Sonnet FAIL** — quadrant=noop, category=scheduling, I=2, U=1, conf=5, calEvent=false
  Misses: category: work→scheduling
  Summary: No action needed — 1:1 with Sarah is already accepted and on the calendar
  Reasoning: This is a calendar confirmation for a recurring weekly 1:1. The user has already responded 'Yes' and the event is on the calendar. No further action is required.

**Opus FAIL** — quadrant=noop, category=scheduling, I=2, U=1, conf=5, calEvent=false
  Misses: category: work→scheduling
  Summary: No action — recurring 1:1 already accepted
  Reasoning: This is a confirmation of an already-accepted recurring calendar event. The user has already responded 'Yes' and the meeting is on the calendar. No further action is required.

---
### plan-calendar-invite-interview-loop-01
**Description:** Accepted invite, important, requires prep, 8 days out. Tests 'important + needs prep + not yet urgent = Plan'.
**Expected:** quadrant=plan, category=work, importance=high, urgency=low, calEvent=false

**Sonnet FAIL** — quadrant=plan, category=work, I=4, U=3, conf=4, calEvent=true
  Misses: urgencyBucket: low→medium, calendarEvent: false→true
  Summary: Prepare for Priya Ramaswamy's final round staff engineer interview on May 26 — review her resume and draft 2-3 system design questions
  Reasoning: The interview is 8 days away, giving meaningful preparation margin — hence Plan, not Hot or Action. However, quality interviewing for a staff engineer hire has real downstream impact (team composition, hiring bar), and the user has explicit responsibility as a loop participant. Preparation should begin in the next few days to avoid a last-minute scramble. The calendar acceptance is already on file so no RSVP action is needed.

**Opus FAIL** — quadrant=plan, category=work, I=4, U=3, conf=4, calEvent=false
  Misses: urgencyBucket: low→medium
  Summary: Prep for Priya Ramaswamy's staff engineer final-round interview on May 26
  Reasoning: Interview is 8 days out — important hiring decision with real stakes, and you're explicitly asked to prepare. Not urgent today, but prep should happen well before the 26th so questions are thoughtful. Schedule prep block by end of this week to leave room for refinement.

---
### noop-calendar-invite-allhands-01
**Description:** External invite marked 'Optional'. Tests that classifier respects the Optional flag — no obligation to attend.
**Expected:** quadrant=noop, category=work, importance=low, urgency=low, calEvent=false

**Sonnet FAIL** — quadrant=noop, category=notification, I=2, U=1, conf=5, calEvent=false
  Misses: category: work→notification
  Summary: No action required — optional all-hands with recording available afterward
  Reasoning: Explicitly marked optional, attendance is not required, and a recording will be posted afterward. The calendar invite is already on the calendar and needs no further action from the user. Response status 'Needs Action' is a calendar system artifact, but given the optional nature and recording availability, there is no meaningful obligation to formally respond.

**Opus PASS** — quadrant=noop, category=work, I=1, U=1, conf=5, calEvent=false
  Summary: No action required — optional all-hands with recording available
  Reasoning: Attendance is explicitly optional and a recording will be posted, so no response or commitment is needed from the user.

---
### action-calendar-invite-urgent-escalation-01
**Description:** Last-minute external invite for tomorrow morning. Tests 'high-stakes + tight timing + pending RSVP = Action with high urgency and high importance'.
**Expected:** quadrant=action, category=work, importance=high, urgency=high, calEvent=false

**Sonnet PASS** — quadrant=action, category=work, I=4, U=5, conf=4, calEvent=false
  Summary: Accept or decline tomorrow's Acme escalation sync — if declining, send written input tonight before the 10am customer call
  Reasoning: The meeting is tomorrow at 8am, and the organizer explicitly asks for a response or written input tonight — making this time-critical today, not tomorrow. The customer call follows at 10am, meaning alignment on messaging must happen before then. Failing to respond leaves the team without your input going into a live customer escalation. Not quite Hot because the user still has several hours to respond, but Urgency is maxed due to the tonight deadline and shrinking window.

**Opus PASS** — quadrant=action, category=work, I=4, U=5, conf=4, calEvent=false
  Summary: Respond to 8am escalation review invite — accept or send written input tonight
  Reasoning: Meeting is tomorrow morning with explicit ask for response (attend or provide written input tonight). Tied to a customer call at 10am, so messaging alignment has real downstream impact. Invite still shows 'Needs Action,' so a decision is required now.

---
### plan-calendar-invite-bday-dinner-01
**Description:** Social invite from a friend, 4 weeks out, pending RSVP. Tests 'distant social obligation = Plan, not Action'.
**Expected:** quadrant=plan, category=social, importance=medium, urgency=low, calEvent=false

**Sonnet FAIL** — quadrant=action, category=social, I=4, U=3, conf=5, calEvent=false
  Misses: quadrant: plan→action, importanceBucket: medium→high, urgencyBucket: low→medium
  Summary: RSVP to Marco's 40th birthday dinner for you and Stacy by end of May
  Reasoning: Marco needs a headcount to finalize the reservation by end of May — about 13 days away. The dinner itself is June 13 at Veritas Italian Restaurant. This is a milestone birthday (40th) for a friend, so the relational meaning is high. No hard consequence today, but the RSVP window closes at end of month, and delaying risks leaving Marco without an accurate count. Stacy's availability should be confirmed before replying.

**Opus FAIL** — quadrant=action, category=social, I=4, U=3, conf=4, calEvent=false
  Misses: quadrant: plan→action, importanceBucket: medium→high, urgencyBucket: low→medium
  Summary: RSVP to Marco about his 40th birthday dinner on June 13
  Reasoning: Marco needs a headcount for the reservation by end of May — about 13 days from now. A 40th birthday is a meaningful, non-repeatable milestone for a friend, raising the relational/meaning weight. Action is light (one reply) but requires coordinating with Stacy first, so worth handling this week rather than waiting until the deadline.

---
### action-calendar-invite-dentist-01
**Description:** Health appointment invite, 4 days out, with explicit 48-hour confirmation window. Tests non-work appointment + short confirmation deadline = Action.
**Expected:** quadrant=action, category=health, importance=medium, urgency=medium, calEvent=false

**Sonnet FAIL** — quadrant=action, category=health, I=3, U=4, conf=5, calEvent=true
  Misses: urgencyBucket: medium→high, calendarEvent: false→true
  Summary: Confirm dental cleaning appointment with Dr. Patel by May 20 (48-hour advance notice required)
  Reasoning: The appointment is Friday May 22 at 9:00 AM. The office requests 48-hour advance confirmation, meaning the deadline to confirm (or reschedule) is Wednesday May 20 at 9:00 AM — roughly 44 hours from now. The calendar event is marked 'Needs Action,' so the user has not yet responded. Delay past Wednesday risks losing the slot or being marked as a no-show.

**Opus FAIL** — quadrant=action, category=health, I=3, U=4, conf=4, calEvent=false
  Misses: urgencyBucket: medium→high
  Summary: Confirm Friday's dental cleaning appointment with Dr. Patel
  Reasoning: Appointment is in 4 days and the office requests confirmation 48 hours in advance, which falls on Wednesday, May 20. The calendar invite is also marked 'Needs Action,' so a response is required soon. Low stakes but a clear obligation with a near-term timing requirement.

---
### edge-chat-ambiguous-dad-01
**Description:** Deliberately ambiguous chat — 'that thing for Dad' has no specific action, no timing, no context. Classifier SHOULD pick low confidence (≤ 2) and emit clarification_question. The Zod schema's .refine enforces this — if confidence ≤ 2 without a clarification question, the parse fails entirely (PARSE_FAIL). Expected quadrant is best-guess Plan; if the classifier picks Hot/Action with high confidence, it's hallucinating specificity that isn't in the input.
**Expected:** quadrant=plan, category=personal, importance=medium, urgency=low, calEvent=false

**Sonnet PASS** — quadrant=plan, category=personal, I=3, U=2, conf=1, calEvent=false
  Summary: Handle unspecified task related to Dad
  Reasoning: The message is entirely ambiguous — no task, deadline, or context is given. Could be anything from a gift to a medical appointment to a financial errand. Meaning is elevated because it involves a family member, and there may be time sensitivity once the task is identified. Cannot classify accurately without knowing what the task is.

**Opus FAIL** — quadrant=action, category=personal, I=4, U=2, conf=1, calEvent=false
  Misses: quadrant: plan→action, importanceBucket: medium→high
  Summary: Handle unspecified task related to Dad
  Reasoning: Message references a prior context the assistant doesn't have access to. Family-related obligations typically carry meaning and responsibility, but without knowing whether this is a gift, a call, paperwork, a medical task, or something else, neither the action nor its urgency can be determined.

---
### plan-capture-syllabus-01
**Description:** Captured PDF: a Texas A&M intro-to-digital-systems syllabus for Fall 2026. Tests how the classifier handles a multi-deadline reference document. Boundary case: Plan vs Action. Labeled Plan because all deadlines are 4+ months out and nothing needs to happen this week; the implied action ('extract dates and add to calendar') is itself semester-level planning. Should NOT emit a single suggested_calendar_event — the document contains many dates, not one event.
**Expected:** quadrant=plan, category=personal, importance=high, urgency=low, calEvent=false

**Sonnet FAIL** — quadrant=plan, category=other, I=4, U=2, conf=4, calEvent=true
  Misses: category: personal→other, calendarEvent: false→true
  Summary: Set up for ECEN 248 Fall 2026: acquire Basys 3 board, install Vivado, obtain textbook, and add all key deadlines to calendar before semester starts
  Reasoning: The semester doesn't start until Fall 2026 — roughly 3.5 months away — so nothing is immediately urgent. However, several prep steps benefit from early action: the Basys 3 board ($165) and textbook should be procured before Week 1 labs begin; Vivado installation can take time on some systems; and the accommodation deadline (first two weeks of semester) is easy to miss if not calendared now. The first hard deadline (HW 1) is Fri Sep 11, 2026. Capturing all key dates now prevents surprises later. No items appear to be already tracked.

**Opus PASS** — quadrant=plan, category=personal, I=4, U=2, conf=4, calEvent=false
  Summary: Prepare for ECEN 248 fall semester: buy Basys 3 board, install Vivado, and add key deadlines to calendar
  Reasoning: Fall 2026 syllabus captured in May — there's no urgency now, but the course has significant materials prep (FPGA board purchase, software install) and many graded deadlines that should be scheduled in advance. Responsibility is high (it's the user's course), but immediacy is low since the semester is months away. Worth planning rather than acting on now.

---
### edge-chat-pure-context-01
**Description:** Pure context, no actionable content. Tests that the classifier doesn't hallucinate an action from a pure declarative statement. Should be Noop. If classifier picks Plan ('plan something about this place') or Monitor ('monitor College Station news'), it's over-classifying. In production this kind of message should be routed to save_context upstream, but if it lands in classifyAndStore, Noop is the right floor.
**Expected:** quadrant=noop, category=personal, importance=low, urgency=low, calEvent=false

**Sonnet PASS** — quadrant=noop, category=personal, I=1, U=1, conf=5, calEvent=false
  Summary: No action needed — user shared location context for future reference
  Reasoning: This is a purely informational message with no request, deadline, decision, or obligation attached. The user is sharing a fact for future context. Nothing to act on, monitor, or plan.

**Opus PASS** — quadrant=noop, category=personal, I=1, U=1, conf=5, calEvent=false
  Summary: No action — user shared location context for future reference
  Reasoning: User is providing static personal context (location) to the assistant. There is no task, deadline, or decision required. This is informational only.

---
### action-chat-plumber-reminder-01
**Description:** Chat: explicit reminder request for tomorrow morning. Tests the canonical 'remind me to X tomorrow' Action case.
**Expected:** quadrant=action, category=personal, importance=medium, urgency=high, calEvent=false

**Sonnet FAIL** — quadrant=action, category=personal, I=4, U=3, conf=5, calEvent=true
  Misses: importanceBucket: medium→high, urgencyBucket: high→medium, calendarEvent: false→true
  Summary: Call plumber about leaking kitchen sink
  Reasoning: User explicitly requested a reminder to call the plumber tomorrow morning. The sink has been leaking for two days already, meaning the user has been deferring this task. A slow leak can cause water damage, mold, or worsening structural issues over time, so further delay has real consequences. Responsibility is high — this is the user's home and their explicitly self-assigned task. Urgency is moderate: not an emergency burst pipe, but not something to keep ignoring either.

**Opus FAIL** — quadrant=action, category=personal, I=3, U=3, conf=4, calEvent=true
  Misses: urgencyBucket: high→medium, calendarEvent: false→true
  Summary: Call plumber tomorrow morning about leaking kitchen sink
  Reasoning: User explicitly asked to be reminded. Leak has been ongoing for two days and water damage risk grows the longer it's deferred, but it's not an emergency flood. Clear timing (tomorrow morning) and clear ownership make this a near-term Action item rather than Plan.

---
### hot-chat-kid-injury-01
**Description:** Chat: kid medical situation in progress. Tests that the classifier recognizes a Hot case from chat without needing clarification — high importance + immediate action both clearly signaled.
**Expected:** quadrant=hot, category=health, importance=high, urgency=high, calEvent=false

**Sonnet PASS** — quadrant=hot, category=health, I=5, U=5, conf=5, calEvent=false
  Summary: Get Jake from school and to urgent care for suspected broken arm
  Reasoning: Child may have a fracture requiring prompt medical evaluation. User is already in motion (leaving work now), which is the right response. Key loose ends: confirm Stacy's acknowledgment, bring insurance/ID docs, and notify the school you're en route. No other items in the queue conflict with or supersede this.

**Opus PASS** — quadrant=hot, category=health, I=5, U=5, conf=5, calEvent=false
  Summary: Pick up Jake from school and take him to urgent care on Briarcrest for possible broken arm
  Reasoning: Child has a suspected fracture and needs medical evaluation now. User is already acting; this is the top priority and overrides any work commitments on the calendar this afternoon. Spouse has been notified, so coordination is in motion.

---
### edge-chat-multi-action-01
**Description:** Compound message with three distinct action items of varying urgency. Classifier today produces one item per input, so it must pick one. Tax filing (Q1 taxes implied near-deadline) is the most urgent, so Action is the expected quadrant. Boundary case: classifier might (a) pick taxes specifically (good), (b) produce a vague 'three errands to run' summary (mediocre), or (c) hallucinate dates/details for any of them (bad). Watch the raw output, not just the pass/fail.
**Expected:** quadrant=action, category=billing, importance=high, urgency=high, calEvent=false

**Sonnet FAIL** — quadrant=hot, category=billing, I=4, U=5, conf=4, calEvent=false
  Misses: quadrant: action→hot
  Summary: File Q1 estimated taxes before the deadline this week — also call dentist about crown pain and book Phoenix flight for July
  Reasoning: This is a composite capture with three distinct items. The Q1 estimated tax filing deadline is the most urgent — it is this week (likely June 15), and missing it incurs IRS penalties plus interest. That alone pushes this to Hot. The dental crown pain has health implications and should not be ignored, but it's not an emergency requiring same-day action. The Phoenix flight for July is important enough to book soon to avoid price increases or seat scarcity, but has meaningful lead time. The tax filing is the anchor that drives the Hot classification for this batch.

**Opus FAIL** — quadrant=action, category=other, I=4, U=5, conf=2, calEvent=false
  Misses: category: billing→other
  Summary: Handle three tasks: call dentist about crown, file Q1 estimated taxes this week, book Phoenix flight for July
  Reasoning: Message bundles three separate actions with different urgencies. Taxes have a hard deadline this week and carry penalty risk if missed — highest urgency. Dental crown pain is a health issue that should be addressed promptly but is not emergency-level. Phoenix flight for July has weeks of runway and is Plan-level. Scoring reflects the tax deadline as the dominant urgency driver since it's the binding constraint this week.

---
### action-chat-tax-deadline-01
**Description:** Chat: explicit commitment with a near-term financial deadline. Tests Action with high importance + high urgency from a chat-stated obligation.
**Expected:** quadrant=action, category=billing, importance=high, urgency=high, calEvent=false

**Sonnet FAIL** — quadrant=hot, category=billing, I=4, U=5, conf=4, calEvent=true
  Misses: quadrant: action→hot, calendarEvent: false→true
  Summary: File Q1 estimated taxes by Wednesday to avoid penalties
  Reasoning: The deadline is Wednesday, May 20 — only 2 days from now (today is Monday, May 18 at 1:30 PM CDT). User has already been procrastinating and explicitly flagged penalty risk. Missing estimated tax deadlines triggers IRS underpayment penalties, which are financial consequences that compound. With less than 48 hours remaining and likely prep work needed (calculating income, gathering figures), this is Hot — the window to act without penalty is closing fast.

**Opus FAIL** — quadrant=hot, category=legal, I=4, U=5, conf=5, calEvent=true
  Misses: quadrant: action→hot, category: billing→legal, calendarEvent: false→true
  Summary: File Q1 estimated taxes by Wednesday May 20
  Reasoning: User has explicitly stated a hard deadline 2 days away (Wed May 20) with financial penalty consequences for missing it. User is solely responsible. Already procrastinated for weeks, so immediacy is maximal — action must begin now to avoid IRS underpayment penalties and interest.

---
### action-chat-interview-calendar-01
**Description:** Chat: user mentions a specific upcoming meeting and asks for it on the calendar. Tests Action AND suggested_calendar_event emission from chat (the classifier should propose a calendar event with the stated time).
**Expected:** quadrant=action, category=work, importance=high, urgency=medium, calEvent=true

**Sonnet PASS** — quadrant=action, category=work, I=5, U=3, conf=4, calEvent=true
  Summary: Add TechCorp final-round interview to calendar and begin interview prep
  Reasoning: Final-round interviews are high-stakes and non-repeatable — missing or under-preparing could cost a significant career opportunity. The interview is next Tuesday (May 26), giving roughly 8 days. The calendar event needs to be created now to anchor logistics, and prep should start soon to avoid cramming. No indication this is already on the calendar. Urgency is moderate (not immediate crisis) but should not be deferred past today or tomorrow.

**Opus FAIL** — quadrant=plan, category=personal, I=5, U=3, conf=4, calEvent=true
  Misses: quadrant: action→plan, category: work→personal
  Summary: Prep for final-round TechCorp interview next Tuesday 2pm
  Reasoning: Final-round interview is high-impact career event with 8 days until execution — enough margin for structured prep, so urgency is moderate not hot. Importance is maximal given career consequences and personal meaning. Calendar event needed; prep tasks should be scheduled across the week.

---
### plan-chat-parents-trip-01
**Description:** Chat: long-range goal stated, no specific date yet. Tests Plan for a multi-step intention that's months out and ambiguous on timing.
**Expected:** quadrant=plan, category=travel, importance=medium, urgency=low, calEvent=false

**Sonnet FAIL** — quadrant=plan, category=travel, I=4, U=2, conf=4, calEvent=true
  Misses: importanceBucket: medium→high, calendarEvent: false→true
  Summary: Plan July trip to Phoenix to visit parents — book flights, align on dates with Stacy, and arrange childcare
  Reasoning: User-initiated planning task with no hard deadline yet, but July is ~6 weeks out. Flight prices for July travel tend to rise as the date approaches, so acting within the next 1–2 weeks preserves options and pricing. Three sub-tasks exist: (1) coordinate dates with Stacy, (2) book flights, (3) arrange kids' care. Coordinating with Stacy is the gating dependency — nothing else can be finalized without agreed dates. Meaningful trip due to family/relational significance; not urgent today but has a real booking window.

**Opus FAIL** — quadrant=plan, category=personal, I=4, U=2, conf=4, calEvent=false
  Misses: category: travel→personal, importanceBucket: medium→high
  Summary: Plan July trip to visit parents in Phoenix
  Reasoning: Trip is ~6-10 weeks out, giving runway to coordinate. Multiple sub-tasks (date alignment with Stacy, flights, childcare) benefit from early action since flight prices rise and childcare arrangements need lead time. Personally meaningful (visiting parents) but not urgent today.

---
### monitor-chat-contract-pending-01
**Description:** Chat: user explicitly states they're waiting on someone else's action with a defined check-in trigger. Tests Monitor with an implicit next_check_at (~Thursday). If classifier picks Action, it's misreading 'I should follow up if I don't hear by Thursday' as immediate work.
**Expected:** quadrant=monitor, category=work, importance=high, urgency=low, calEvent=false

**Sonnet FAIL** — quadrant=monitor, category=work, I=4, U=3, conf=5, calEvent=true
  Misses: urgencyBucket: low→medium, calendarEvent: false→true
  Summary: Follow up with Jamie if signed contract not received by Thursday
  Reasoning: The user explicitly set a Thursday follow-up trigger. Jamie committed to returning the signed contract by end of week (Friday, May 22). No action is needed now — the user is waiting on Jamie. If Thursday (May 21) passes without the contract, the user should follow up to protect the timeline for the consulting engagement. next_check_at is set to Thursday morning to resurface this item at the right moment.

**Opus FAIL** — quadrant=monitor, category=work, I=4, U=3, conf=5, calEvent=false
  Misses: urgencyBucket: low→medium
  Summary: Follow up with Jamie on Thursday if signed contract hasn't arrived
  Reasoning: User is waiting on someone else's action (Jamie sending the contract), so the current action is vigilance, not execution. Jamie committed to end of week, so Thursday is the right re-surface point to leave room to chase before the week ends. Contract for a consulting gig has meaningful financial/operational impact, but no action is needed today.

---
### plan-chat-physical-exam-01
**Description:** Chat: overdue health admin with no hard deadline. Tests Plan for a 'should-do, important, no urgency' case — the most-procrastinated kind of action item.
**Expected:** quadrant=plan, category=health, importance=medium, urgency=low, calEvent=false

**Sonnet PASS** — quadrant=plan, category=health, I=3, U=2, conf=4, calEvent=false
  Summary: Book annual physical with doctor's office
  Reasoning: User self-identified this as overdue (last physical was over a year ago) and has already received a reminder from the doctor's office that went unanswered. There is no hard deadline, acute symptom, or imminent health risk mentioned, so this doesn't rise to Hot or Action. However, it's a real health maintenance obligation the user has acknowledged and deferred — it belongs in Plan as something to schedule deliberately. Urgency is low because there's no time-critical window, but importance is moderate given the preventive health value and the fact that the user has already been prompted once and ignored it.

**Opus FAIL** — quadrant=action, category=health, I=3, U=3, conf=4, calEvent=false
  Misses: quadrant: plan→action, urgencyBucket: low→medium
  Summary: Book overdue annual physical with primary care doctor
  Reasoning: User explicitly stated intent to act. Physical is overdue by a year and a prior reminder went unanswered, so responsibility is high. No hard deadline, but the longer it slips the more it slides; booking is a quick task that unblocks the actual appointment date. Not urgent enough for Hot, but concrete and ready to execute — fits Action rather than Plan.

---
### monitor-chat-package-tracking-01
**Description:** Chat: tracking a shipment with a specific expected arrival. Classic Monitor — vigilance, not execution. next_check_at should be ~Friday. The kid-NSC context adds mild importance.
**Expected:** quadrant=monitor, category=shopping, importance=medium, urgency=low, calEvent=false

**Sonnet PASS** — quadrant=monitor, category=shopping, I=3, U=2, conf=4, calEvent=false
  Summary: Track Best Buy package 1Z999AA10123456784 to confirm Derek's charger arrives before NSC departure on May 27
  Reasoning: Package is expected Friday May 22, giving a 5-day buffer before Derek leaves for NSC on May 27. No action needed now — this is a watch item until delivery is confirmed or a problem emerges. If Friday's delivery fails or tracking shows a delay, there is still time to source a replacement before the 27th, but the window would be tight. Re-surface Friday morning to verify delivery status.

**Opus FAIL** — quadrant=monitor, category=shopping, I=3, U=3, conf=4, calEvent=false
  Misses: urgencyBucket: low→medium
  Summary: Watch for laptop charger delivery (1Z999AA10123456784); ensure it arrives before Derek leaves for NSC on May 27
  Reasoning: User is awaiting a package, not executing a task. Expected delivery Friday May 22 leaves a 5-day buffer before Derek's NSC departure on May 27, so urgency is moderate. Re-check on the promised delivery date to confirm arrival and act if it slips.

---
### noop-chat-journaling-01
**Description:** Chat: positive journaling, no action implied. Tests that the classifier doesn't over-classify reflective statements as Action. The user is logging a feeling, not requesting work.
**Expected:** quadrant=noop, category=personal, importance=low, urgency=low, calEvent=false

**Sonnet FAIL** — quadrant=noop, category=personal, I=3, U=1, conf=5, calEvent=false
  Misses: importanceBucket: low→medium
  Summary: No action needed — user logged a positive moment for personal reflection.
  Reasoning: The user explicitly framed this as a memory capture ('want to track that I'm liking this stretch of work — easy to forget when things get hard later'). There is no task, deadline, or required response. The item has personal/emotional meaning worth preserving, but by design requires nothing further from the user. Classified as Noop so it's stored for completeness.

**Opus PASS** — quadrant=noop, category=personal, I=2, U=1, conf=4, calEvent=false
  Summary: No action — journal note logged for future reference
  Reasoning: User is logging a positive emotional state for personal record-keeping. No request, no deadline, no coordination, no decision pending. Meaningful as a journal entry but requires no execution or vigilance.

---
### action-email-dentist-01
**Description:** Dentist appointment confirmation needing reply — action quadrant
**Expected:** quadrant=action, category=health, importance=medium, urgency=medium, calEvent=true

**Sonnet FAIL** — quadrant=action, category=health, I=3, U=4, conf=5, calEvent=true
  Misses: urgencyBucket: medium→high
  Summary: Reply to Smile Dental to confirm (or reschedule) the May 22 cleaning appointment
  Reasoning: The dental office explicitly requires a confirmation by Wednesday, May 20, or the slot may be released. Today is Monday May 18, leaving roughly 48 hours to respond. No action means losing the appointment. Low-stakes health maintenance, but the hard Wednesday deadline and the risk of losing the slot make this time-sensitive and requiring near-immediate action.

**Opus FAIL** — quadrant=action, category=health, I=3, U=4, conf=5, calEvent=true
  Misses: urgencyBucket: medium→high
  Summary: Confirm dental cleaning appointment on May 22 with Smile Dental
  Reasoning: Confirmation required by Wednesday May 20 (2 days from now) or the slot may be released. Low-effort reply but time-bound. Appointment is Thursday May 22 at 2:00 PM — verify no calendar conflict.

---
### hot-email-outage-01
**Description:** Production outage alert — hot quadrant
**Expected:** quadrant=hot, category=work, importance=high, urgency=high, calEvent=false

**Sonnet PASS** — quadrant=hot, category=work, I=5, U=5, conf=4, calEvent=false
  Summary: Acknowledge and investigate production API gateway outage — 94% error rate affecting all customers since 11:25 AM
  Reasoning: This is an active, customer-facing production outage with a 94% error rate that has been ongoing for ~2 hours as of now (started 11:25 AM, current time 1:30 PM). Every minute of delay compounds customer impact and potential SLA/revenue consequences. The alert explicitly requests immediate acknowledgment and investigation. Confidence is 4 rather than 5 because it's unclear if the user is the on-call engineer, a manager, or a secondary responder — but regardless of role, this is Hot given severity and elapsed time.

**Opus PASS** — quadrant=hot, category=work, I=5, U=5, conf=5, calEvent=false
  Summary: Acknowledge and investigate API gateway 503 outage as on-call engineer
  Reasoning: User is named on-call engineer for a customer-facing production outage with 94% error rate ongoing for several minutes. Every minute of delay impacts all API customers. Maximum urgency and impact; direct personal responsibility.

---
### plan-email-dinner-01
**Description:** Friend asking to schedule dinner — plan quadrant (important, not urgent)
**Expected:** quadrant=action, category=social, importance=medium, urgency=low, calEvent=true

**Sonnet FAIL** — quadrant=action, category=social, I=3, U=3, conf=4, calEvent=true
  Misses: urgencyBucket: low→medium
  Summary: Reply to Mike about dinner Saturday at 7pm at the new Thai place on Main Street
  Reasoning: Mike sent this today and is proposing dinner this Saturday (May 23). While there's no hard deadline, replying promptly is socially expected and allows Mike to make plans. Waiting too long risks the window closing or Mike making other arrangements. No calendar conflict is visible, but user should check before confirming.

**Opus FAIL** — quadrant=action, category=social, I=3, U=3, conf=5, calEvent=false
  Misses: urgencyBucket: low→medium, calendarEvent: true→false
  Summary: Reply to Mike about Saturday dinner at the Thai place on Main Street at 7pm
  Reasoning: Direct personal invitation from a friend that requires a response. Saturday is 5 days out, so there's modest timing pressure to confirm so Mike can plan. Low practical stakes but meaningful for the friendship.

---
### hot-email-billing-01
**Description:** Credit card payment due in 3 days — hot quadrant
**Expected:** quadrant=hot, category=billing, importance=high, urgency=high, calEvent=false

**Sonnet FAIL** — quadrant=action, category=billing, I=3, U=4, conf=5, calEvent=true
  Misses: quadrant: hot→action, importanceBucket: high→medium, calendarEvent: false→true
  Summary: Pay Chase Sapphire Preferred statement balance of $2,847.32 by May 21
  Reasoning: Due date is May 21, 2026 — 3 days from now. Missing this results in late fees and interest charges on a $2,847.32 balance, and may affect credit. High time-sensitivity given the narrow window. Urgency is real but not hot — there are still 3 days to act and no irreversible harm has occurred yet.

**Opus FAIL** — quadrant=action, category=billing, I=4, U=4, conf=5, calEvent=true
  Misses: quadrant: hot→action, calendarEvent: false→true
  Summary: Pay Chase Sapphire Preferred statement balance ($2,847.32) by May 21
  Reasoning: Credit card payment due in 3 days. Missing the deadline triggers late fees, interest charges on the full balance, and potential credit score impact. User is solely responsible for paying their own card. Not an emergency today, but should be handled within the next 1-2 days to avoid risk.

---
### action-email-meeting-01
**Description:** Meeting request with specific time — action quadrant, creates calendar event
**Expected:** quadrant=action, category=scheduling, importance=medium, urgency=medium, calEvent=true

**Sonnet PASS** — quadrant=action, category=scheduling, I=3, U=3, conf=4, calEvent=true
  Summary: Reply to Sarah confirming or rescheduling the Wednesday May 20 10am 1:1 sync
  Reasoning: Sarah needs a response to confirm the meeting before Wednesday — she's preparing for a full team meeting next week and wants alignment beforehand. The meeting is 2 days away, so a reply today or tomorrow keeps coordination smooth. No blocking urgency, but waiting too long risks her not having a confirmed slot.

**Opus FAIL** — quadrant=action, category=scheduling, I=3, U=4, conf=5, calEvent=true
  Misses: urgencyBucket: medium→high
  Summary: Reply to Sarah confirming Wed May 20 10am 1:1 for Q3 kickoff planning
  Reasoning: Sarah is requesting a meeting in 2 days; a response is needed soon so she can lock the time and prep. Moderately important (planning meeting before broader team kickoff) with clear timing pressure on the reply, though stakes are routine.

---
### hot-email-security-01
**Description:** Security alert — suspicious sign-in, hot quadrant
**Expected:** quadrant=hot, category=security, importance=high, urgency=high, calEvent=false

**Sonnet PASS** — quadrant=hot, category=security, I=5, U=5, conf=4, calEvent=false
  Summary: Change Google account password and review security activity after blocked sign-in from Moscow
  Reasoning: A blocked sign-in from Moscow just occurred at 2:00 PM today — 30 minutes ago. While Google blocked this attempt, it explicitly states that someone knows your password, meaning the credential is compromised. The account could be accessed via another vector or a different service reusing the same password. Immediate password rotation is essential. This is a live threat, not a hypothetical. Confidence is 4 rather than 5 only because there's a small chance this is a Google phishing email — verify the link goes to myaccount.google.com before clicking.

**Opus PASS** — quadrant=hot, category=security, I=5, U=5, conf=4, calEvent=false
  Summary: Review Google account activity and change password after blocked sign-in attempt from Moscow
  Reasoning: A blocked foreign sign-in attempt strongly suggests password compromise. Even though Google blocked this attempt, the attacker knowing the password means subsequent attempts could succeed or other accounts reusing the password are at risk. Immediate password change and security review is critical.

---
### hot-email-thread-01
**Description:** Long email thread where action is buried — hot (deadline is 2 days away)
**Expected:** quadrant=hot, category=personal, importance=high, urgency=high, calEvent=false

**Sonnet FAIL** — quadrant=action, category=other, I=4, U=5, conf=5, calEvent=true
  Misses: quadrant: hot→action, category: personal→other, calendarEvent: false→true
  Summary: Sign and return the $1,200 quartz upgrade change order to contractor Dave by Wednesday May 20
  Reasoning: Wes already indicated he was considering the quartz upgrade and asked for the weekend to think it over — now the contractor has a concrete deadline (Wed May 20) tied to locking in both a delivery slot (June 2) and an install crew (June 3-4). Missing the Wednesday deadline risks losing the install crew booking, potentially delaying the entire kitchen renovation. The $1,200 decision is meaningful but bounded. Today is Monday, leaving only today and Tuesday as working days before the deadline. Action is required within 48 hours.

**Opus FAIL** — quadrant=action, category=personal, I=4, U=4, conf=5, calEvent=true
  Misses: quadrant: hot→action, calendarEvent: false→true
  Summary: Sign change order approving quartz upgrade ($1,200) by Wednesday May 20
  Reasoning: Wes is the decision-maker and only he can authorize the change order. Hard deadline is Wednesday May 20 — just 2 days away — and missing it jeopardizes the June 2 delivery and June 3-4 install schedule. Financial commitment is modest ($1,200) so impact is moderate, but responsibility and timing pressure are high. Wes already signaled interest in weighing the option over the weekend, so a decision is overdue.

---
### noop-email-policy-01
**Description:** HR policy update — FYI, noop quadrant
**Expected:** quadrant=noop, category=work, importance=low, urgency=low, calEvent=false

**Sonnet FAIL** — quadrant=plan, category=work, I=3, U=2, conf=4, calEvent=false
  Misses: quadrant: noop→plan, importanceBucket: low→medium
  Summary: Review updated PTO policy before it takes effect June 1
  Reasoning: Policy takes effect June 1 — 14 days from now. No immediate action is required today, but the user should be aware before the effective date, especially if they have PTO requests in flight or planned absences over 3 days that may now require documentation or 2-week advance notice. The carryover limit change could also affect year-end planning. Low immediacy now, but worth reviewing this week to avoid being caught off guard.

**Opus FAIL** — quadrant=monitor, category=work, I=2, U=2, conf=4, calEvent=false
  Misses: quadrant: noop→monitor
  Summary: Review updated PTO policy before it takes effect June 1
  Reasoning: Policy change affects the user but requires no immediate action. Worth resurfacing near the June 1 effective date so the user is aware before requesting PTO under the new rules. Classic monitor: watch for state change, act only if/when planning future time off.

---
### plan-email-okr-01
**Description:** Important task with far-future deadline — plan quadrant
**Expected:** quadrant=plan, category=work, importance=medium, urgency=low, calEvent=false

**Sonnet FAIL** — quadrant=plan, category=work, I=4, U=2, conf=5, calEvent=true
  Misses: importanceBucket: medium→high, calendarEvent: false→true
  Summary: Draft Q3 OKRs for your team by July 15
  Reasoning: Deadline is July 15 — 58 days from now — with a review session the week of July 21. Substantial margin remains, so immediacy is low, but this is a real accountability item (responsibility: 4) with meaningful strategic impact on team direction (impact: 4). No urgency to act today, but worth scheduling a working session in June to avoid a last-minute scramble. Not yet urgent enough for Action.

**Opus FAIL** — quadrant=plan, category=work, I=4, U=2, conf=4, calEvent=true
  Misses: importanceBucket: medium→high, calendarEvent: false→true
  Summary: Draft Q3 OKRs by July 15
  Reasoning: OKRs are an important work deliverable with real strategic impact and clear personal responsibility, but the July 15 deadline is nearly 2 months away. Plenty of preparation margin remains, so urgency is low. Worth scheduling preparation time now to avoid a last-minute scramble, and noting the July 21 review week.

---
### monitor-email-awaiting-reply-01
**Description:** Waiting on someone else's decision — monitor quadrant
**Expected:** quadrant=monitor, category=work, importance=medium, urgency=low, calEvent=false

**Sonnet PASS** — quadrant=monitor, category=work, I=3, U=2, conf=4, calEvent=false
  Summary: Await SupplierCo pricing team's response on bulk order inquiry
  Reasoning: Lisa has acknowledged the inquiry and passed it to the pricing team, with an expected turnaround of 3-5 business days from today (May 18). That puts the expected reply around May 21-23. No action is required from Wes right now — the ball is in SupplierCo's court. The next_check_at is set to May 26 (6 business days out) to allow a small buffer past the quoted window before following up.

**Opus PASS** — quadrant=monitor, category=work, I=3, U=2, conf=4, calEvent=false
  Summary: Await pricing response from SupplierCo (3-5 business days)
  Reasoning: Vendor confirmed the inquiry is being routed to their pricing team. No action required from Wes right now — he's waiting on someone else. 3-5 business days from May 18 lands around May 21-25; checking in on May 26 gives a small buffer before nudging.

---
### monitor-email-shipment-01
**Description:** Package shipped — track delivery, no action needed now
**Expected:** quadrant=monitor, category=shopping, importance=low, urgency=low, calEvent=false

**Sonnet PASS** — quadrant=monitor, category=shopping, I=2, U=2, conf=5, calEvent=false
  Summary: Track 27" 4K monitor shipment arriving May 22–23
  Reasoning: This is a shipping confirmation — no user action is required now. The package is in transit with UPS and estimated to arrive in 4–5 days. The user should resurface this on May 22 to verify delivery and watch for any delays or missed-delivery notices.

**Opus PASS** — quadrant=monitor, category=shopping, I=2, U=2, conf=4, calEvent=false
  Summary: Watch for monitor delivery May 22-23
  Reasoning: Shipment notification with a delivery window of May 22-23. No action needed now, but worth watching in case of delivery issues or signature requirement. Surfacing on May 23 covers the end of the delivery window.

---
### noop-email-promo-01
**Description:** Promotional newsletter — no action required
**Expected:** quadrant=noop, category=shopping, importance=low, urgency=low, calEvent=false

**Sonnet FAIL** — quadrant=noop, category=newsletter, I=1, U=1, conf=5, calEvent=false
  Misses: category: shopping→newsletter
  Summary: No action needed — promotional sale email from retailstore.com
  Reasoning: This is a standard promotional marketing email advertising a Memorial Day sale. The user has no obligation, pending purchase, or tracked need associated with this retailer. A deadline ('sale ends Monday') creates superficial urgency, but a promotional deadline does not create a genuine user obligation — this is a Noop by definition.

**Opus PASS** — quadrant=noop, category=shopping, I=1, U=1, conf=5, calEvent=false
  Summary: No action needed — promotional sale email
  Reasoning: Marketing email from a retailer advertising a holiday sale. No obligation, no personal context, and no action required from the user. Sale deadlines in promotional emails do not create urgency.

---
### monitor-email-cc-thread-01
**Description:** CC'd on a project thread — not the primary actor
**Expected:** quadrant=monitor, category=work, importance=medium, urgency=low, calEvent=false

**Sonnet FAIL** — quadrant=monitor, category=work, I=3, U=3, conf=4, calEvent=false
  Misses: urgencyBucket: low→medium
  Summary: Watch for Finance team's confirmation of Q3 infrastructure budget allocation (end of week)
  Reasoning: Wes is CC'd on this thread but the action request is directed at the Finance team, not Wes. Alex has already submitted the budget; Finance is responsible for reviewing and confirming. Wes has no immediate task here — the appropriate posture is to watch for the Finance team's response by end of week (May 22). If no confirmation surfaces by then, a follow-up nudge may be warranted. The ~$12K/quarter net increase is a moderate financial change but not a crisis-level decision.

**Opus FAIL** — quadrant=monitor, category=work, I=2, U=2, conf=4, calEvent=false
  Misses: importanceBucket: medium→low
  Summary: Watch for Finance's confirmation of Q3 infrastructure budget allocation
  Reasoning: User is CC'd, not the primary actor. Alex (teamlead) is driving and Finance is the approver. User should monitor for resolution by end of week since infrastructure changes may affect ops, but no direct action is required unless Finance pushes back or asks for team-level breakdown.

---
### noop-email-newsletter-01
**Description:** Tech newsletter digest — informational, no action
**Expected:** quadrant=noop, category=newsletter, importance=low, urgency=low, calEvent=false

**Sonnet PASS** — quadrant=noop, category=newsletter, I=1, U=1, conf=5, calEvent=false
  Summary: No action required — weekly AI tech digest for passive reading
  Reasoning: This is a standard weekly newsletter digest from an automated sender. It contains no calls to action, no deadlines, no decisions, and no obligations. Pure informational content requiring no response or follow-up.

**Opus PASS** — quadrant=noop, category=newsletter, I=1, U=1, conf=5, calEvent=false
  Summary: No action required — informational AI newsletter
  Reasoning: Weekly tech newsletter digest with industry updates. Purely informational, no response or action expected from the user.

---
### noop-email-receipt-01
**Description:** Purchase receipt — no action needed
**Expected:** quadrant=noop, category=shopping, importance=low, urgency=low, calEvent=false

**Sonnet PASS** — quadrant=noop, category=shopping, I=1, U=1, conf=5, calEvent=false
  Summary: No action needed — Amazon order confirmation for USB-C Cable 6ft (2-pack)
  Reasoning: This is an automated order confirmation receipt. No response or decision is required from the user. Delivery is expected May 20–22, which is 2–4 days from now, but tracking is optional and proactive — nothing to act on unless the package fails to arrive.

**Opus PASS** — quadrant=noop, category=shopping, I=1, U=1, conf=5, calEvent=false
  Summary: No action needed — Amazon order confirmation
  Reasoning: Routine order confirmation with no required response. Tracking is available if needed but does not warrant active monitoring for a low-value cable order.

---
### noop-email-notification-01
**Description:** GitHub CI notification — FYI only
**Expected:** quadrant=noop, category=notification, importance=low, urgency=low, calEvent=false

**Sonnet PASS** — quadrant=noop, category=notification, I=1, U=1, conf=5, calEvent=false
  Summary: No action needed — automated CI pass notification for dependabot PR #482
  Reasoning: This is an automated CI/CD notification from GitHub confirming checks passed on a dependabot-created dependency update PR. The user is not the actor; no response, decision, or immediate action is required. Merging dependency PRs may eventually be a task, but that is not what this notification requests — it is purely informational.

**Opus PASS** — quadrant=noop, category=notification, I=1, U=1, conf=5, calEvent=false
  Summary: No action needed — automated CI pass notification
  Reasoning: Automated GitHub notification that CI checks passed on a Dependabot PR. This is informational; no user response is required. PR review/merge, if needed, would be tracked separately as its own action.
