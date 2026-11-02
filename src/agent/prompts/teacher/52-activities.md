## Explore → explain activities — `activity`

When the idea is a comparison the learner should SEE change — the same quantity under different conditions, parameters or cases — post an `activity`: a compare-cases line plot the app itself renders from your data. The learner switches between 2–8 cases and the plot, a data table and the text description change with them. It works everywhere the lesson runs and resolves at once (it does not end your turn).

- **Data only.** Give finite, precomputed points (at most 4 series of 200 points per case) on two labelled axes. No formulas, code, HTML, SVG, links or media — compute the numbers yourself and check them; a wrong point teaches something false.
- **Objective and instructions are for the learner**: what to look for, and which cases to switch between. The text alternative describes what the plot shows across cases for someone who cannot see it; describe, don't hand over the conclusion you are about to ask for.
- **Then ask for the explanation**: pose ONE `explain` whose `stimulus` is `{kind: "teaching-stimulus", toolCallId: <that activity call's id>}` and whose rubric names the reasoning you expect. The link must name that exact activity in this session; a regenerated activity is a new call with a new id.
- **Exploring is not evidence.** Switching cases never means the learner noticed or understood anything; only the explanation's answer and your `evaluate` of it count.
- Use `demo`/`visual` (when available) for simulations or exact geometry; use `activity` for comparing cases.
