# Classifier Eval Baseline — 2026-05-18

46 fixtures, run once per model with no user context or feedback injected.

## Headline numbers

| Metric | Sonnet 4.6 | Opus 4.7 |
|---|---|---|
| **Quadrant accuracy** | **80.4%** | 76.1% |
| Category accuracy | 76.1% | 78.3% |
| Importance bucket | 80.4% | 84.8% |
| Urgency bucket | 76.1% | 69.6% |
| Calendar event | 73.9% | 87.0% |
| **Total cost** | **47.4c** | 301.5c |
| Avg latency | 5,953ms | 6,174ms |

Cost ratio: Opus is **6.4×** more expensive per eval run.

## Per-quadrant accuracy (confusion matrices)

**Sonnet** — Hot 3/5 (60%), Action 8/12 (67%), Plan 8/10 (80%), Monitor 5/5 (100%), Noop 13/14 (93%).
Misses: 2 Hot→Action, 2 Action→Hot, 1 Action→Plan, 1 Plan→Action, 1 Plan→Noop, 1 Noop→Plan.

**Opus** — Hot 3/5 (60%), Action 8/12 (67%), Plan 6/10 (60%), Monitor 5/5 (100%), Noop 13/14 (93%).
Misses: 2 Hot→Action, 1 Action→Hot, 2 Action→Plan, 3 Plan→Action/Noop, 1 Noop→Monitor.

Both models struggle with the **Hot ↔ Action boundary** (billing deadline, long email thread) and with **calendar events lacking context** (grad party, tournament classified as Noop because the model doesn't know the user's family). Monitor and Noop are strong on both.

## Five high-signal fixtures

1. **noop-calendar-hilton-stay-01** — PASS on both. Self-created + accepted event correctly recognized as Noop.

2. **monitor-chat-contract-pending-01** — Quadrant correct (Monitor) on both, but both fail on urgencyBucket (expected low, got medium) and both hallucinate a calendar event. Reasoning is solid — both correctly identified "waiting on Jamie, re-check Thursday."

3. **edge-chat-ambiguous-dad-01** — PASS on Sonnet (Plan, confidence 2 with clarification question). FAIL on Opus — it chose Action with high importance, though it correctly flagged low confidence and asked a clarification question. Opus over-escalated the ambiguity.

4. **edge-chat-multi-action-01** — Both fail. Sonnet chose Hot (anchored on tax deadline); Opus chose Action. Expected Action. The compound input is hard — the tax deadline pulling toward Hot is defensible. Category also drifted (expected billing, Opus said other).

5. **plan-capture-syllabus-01** — PASS on Opus (Plan, correct category personal). FAIL on Sonnet — correct quadrant (Plan) but wrong category (other vs personal) and hallucinated a calendar event. Opus handled the multi-deadline document better.

## Bottom line

Sonnet matches or beats Opus on quadrant accuracy (80.4% vs 76.1%) at 6.4× lower cost. The 5× savings is clearly worth it for the classifier — switch to Sonnet.
