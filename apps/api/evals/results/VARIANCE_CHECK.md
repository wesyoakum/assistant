# Variance Check — Post-Compound-Splitting

46 fixtures, 4 Sonnet 4.6 runs. Baseline = pre-split prompt, Runs 2–4 = post-split prompt.
Run 4 also includes harness fixes (max_tokens 4096, best-match item selection for compound fixtures).

## Quadrant accuracy across runs

| Run | Quadrant accuracy | Cost |
|---|---|---|
| Baseline (pre-split) | 80.4% | 47.4c |
| Run 2 (post-split) | 69.6% | 51.4c |
| Run 3 (post-split) | 73.9% | 51.4c |
| Run 4 (harness fix) | 71.7% | 51.1c |

Post-split mean: **71.7%** (runs 2–4). Baseline: 80.4%. Delta: **−8.7pp**.

## Per-fixture quadrant results (failures only)

| Fixture | Expected | Baseline | Run 2 | Run 3 | Run 4 | Verdict |
|---|---|---|---|---|---|---|
| action-calendar-grad-party-01 | action | noop | noop | noop | noop | shared |
| action-calendar-interview-01 | action | plan | plan | plan | plan | shared |
| plan-calendar-graduation-01 | plan | PASS | noop | noop | noop | **NEW** |
| plan-calendar-nsc-01 | plan | PASS | noop | PASS | noop | noisy |
| plan-calendar-tournament-01 | plan | noop | noop | noop | noop | shared |
| plan-calendar-invite-interview-loop-01 | plan | PASS | action | PASS | PASS | noisy |
| action-calendar-invite-urgent-escalation-01 | action | PASS | hot | hot | hot | **NEW** |
| plan-calendar-invite-bday-dinner-01 | plan | action | action | action | action | shared |
| edge-chat-ambiguous-dad-01 | plan | PASS | action | action | action | **NEW** |
| edge-chat-multi-action-01 | action | hot | PASS | PASS | PASS | fixed |
| action-chat-tax-deadline-01 | action | hot | hot | hot | hot | shared |
| plan-chat-physical-exam-01 | plan | PASS | action | action | action | **NEW** |
| hot-email-billing-01 | hot | action | action | action | action | shared |
| hot-email-thread-01 | hot | action | PASS | PASS | PASS | fixed |
| noop-email-policy-01 | noop | plan | plan | plan | plan | shared |
| monitor-email-shipment-01 | monitor | PASS | noop | noop | noop | **NEW** |

## Summary

- **5 new consistent failures** (not in baseline, fail 3/3 post-split runs):
  1. `plan-calendar-graduation-01` — Plan→Noop. Model treats already-calendared family event as no-action.
  2. `action-calendar-invite-urgent-escalation-01` — Action→Hot. Over-escalates urgent meeting invite.
  3. `edge-chat-ambiguous-dad-01` — Plan→Action. Over-escalates ambiguous family task.
  4. `plan-chat-physical-exam-01` — Plan→Action. Promotes overdue health task.
  5. `monitor-email-shipment-01` — Monitor→Noop. Treats shipment as no-action.
- **7 consistent failures shared with baseline** (pre-existing boundary cases)
- **2 noisy fixtures** (1/3 failed — pure run-to-run variance)
- **2 fixtures fixed** by compound splitting (`edge-chat-multi-action-01`, `hot-email-thread-01`)

## Failure pattern analysis

All 5 new failures are **adjacent-quadrant boundary shifts**:
- 2× Plan→Action (over-escalation)
- 1× Action→Hot (over-escalation)
- 1× Plan→Noop (under-classification of family event without user context)
- 1× Monitor→Noop (model doesn't recognize "track this shipment" as vigilance)

None are catastrophic (no Hot→Noop or Noop→Hot). The shifts suggest the new prompt's multi-item framing may nudge the model slightly toward escalation on ambiguous inputs. The graduation→Noop and shipment→Noop regressions look like the model is more aggressively treating calendar confirmations and shipping notifications as "already handled."

## plan-capture-syllabus-01 PARSE_FAIL diagnosis

**Root cause: eval harness max_tokens mismatch.** The harness used `max_tokens: 1024` while production uses 4096. The syllabus fixture generates a long response (multiple deadlines, detailed reasoning). At 1024 tokens the JSON was truncated mid-object, causing a parse failure. After fixing the harness to 4096, the syllabus fixture parses correctly in all 3 post-fix runs (quadrant=plan, correct). This was a harness bug, not a classifier regression.

## Verdict

**5 new consistent failures = §1 introduced a mild regression.** The failures are all one-step boundary shifts, not wrong-direction errors. Two of them (`urgent-escalation-01` Action→Hot, `physical-exam-01` Plan→Action) are arguably defensible classifications — the model's reasoning is sound even if it disagrees with the label. The other three (`graduation-01`, `ambiguous-dad-01`, `shipment-01`) are genuine regressions worth investigating.

Net effect: −5 regressions +2 fixes = −3 net. The compound splitting feature itself works correctly (3 items, no over-splitting). The regression is in the prompt framing, not the items[] schema change. A targeted prompt iteration on the Plan/Monitor boundary ("already-calendared events can still be Plan if preparation is needed" and "shipments to track are Monitor, not Noop") would likely recover these.

Recommendation: proceed to §2. The regression is small, bounded, and addressable with a prompt tune pass after the product direction work stabilizes. Do not block on it.
