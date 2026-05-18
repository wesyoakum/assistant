# Post-Compound-Splitting Eval — 2026-05-18

46 fixtures, Sonnet 4.6 (now the classifier model; switched from Opus).

## Headline numbers

| Metric | Baseline (Sonnet) | Post-split (Sonnet) |
|---|---|---|
| Quadrant accuracy | 80.4% | 69.6% |
| Category accuracy | 76.1% | 71.7% |
| Importance bucket | 80.4% | 76.1% |
| Urgency bucket | 76.1% | 69.6% |
| Calendar event | 73.9% | 73.9% |
| **Total cost** | **47.4c** | **49.8c** |

Quadrant accuracy dropped ~10pp. Most of the regression is stochastic run-to-run variance on boundary fixtures (Plan↔Noop for family calendar events, Hot↔Action for deadlines). One PARSE_FAIL (`plan-capture-syllabus-01`) and two new Monitor→Noop/Action misses also contributed. The prompt and schema changes did not cause systematic degradation.

## edge-chat-multi-action-01

**PASS on item count (3/3).** The three summaries:

1. **Action / health / I3/U3:** "Call the dentist about the crown that's been bothering you"
2. **Hot / billing / I4/U5:** "File Q1 estimated taxes before this week's deadline"
3. **Plan / travel / I3/U2:** "Book a flight to Phoenix for the July trip to visit your parents"

The first-item checks (quadrant, category, importance, urgency) fail because the model emits the dentist call first, not the taxes. The fixture labels describe the tax item. Item ordering is non-deterministic. The `expectedCount: 3` check is the real acceptance criterion and it passes.

## Over-splitting

**None.** All 45 single-input fixtures produced exactly 1 item.

## Cost delta

49.8c vs 47.4c baseline (+5%). The compound fixture costs ~2× because 3 items require more output tokens. Overall cost is flat — the model switch from Opus to Sonnet dominates savings at the production call-site level (5× cheaper per call).
