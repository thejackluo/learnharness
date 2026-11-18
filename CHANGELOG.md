# LearnHarness changelog: everything changed in this work

**Baseline:** upstream LearnHarness **v0.3.9** (released 2026-10-27, commit `8f6fd7c`): the Electron desktop tutor.
**Now:** `main` at `3b2c6d4` (2026-11-18). That's 19 merged PRs (#1–#8 and #10–#20; there is no #9), with 301 files changed, +25,752 / −558 lines.
**Live at:** https://learn.jack-luo.com (private, only you can sign in). The desktop app still builds from the same code.

## Versioning

- The app version in `package.json` is still **0.3.9**. None of these PRs bumped the version or created a git tag or release, so the version number doesn't show any of this work yet.
- Versioning so far has been by PR number and merge commit. The table below is the effective version history.
- If you want, I can cut a release (for example **0.4.0**) with this changelog as its notes.

| Date | Merge commit | PRs | Lines | Deployed |
|---|---|---|---|---|
| 2026-11-02 | `b541ab8` | #2, #3 | +4,443 / −217 | first hosted deploy, ~2026-11-10/11 |
| 2026-11-03 | `d34d313` | #1 | +1 | n/a |
| 2026-11-04 | `7cafe6c` | #4–#8, #10–#13 (landed together as a stack) | +16,882 / −222 | ~2026-11-10/11 |
| 2026-11-12 | `6899bd1` | #14 | +540 / −98 | 2026-11-12 |
| 2026-11-12 | `e0da6d1` | #15 | +1,054 / −30 | 2026-11-12 |
| 2026-11-12 | `555f8e1` | #16 | +1,306 / −6 | 2026-11-12 |
| 2026-11-13 | `2e247df` | #17 | +226 / −47 | 2026-11-13 |
| 2026-11-18 | `8cdf4bf` | #18 | +1,417 / −50 | 2026-11-18 |
| 2026-11-18 | `3b2c6d4` | #19 | +52 / −58 | 2026-11-18 |
| 2026-11-18 | see #20 | #20 | +61 / −4 | 2026-11-18 |

## What regular LearnHarness (v0.3.9) already had

- Electron desktop app only.
- Mostly multiple-choice questions. Free-text answers existed only behind an "explain" switch.
- Every chat opened with a strict assessment (the "probe"): one question at a time until your level on every topic was pinned down. Then it showed a lesson plan map and waited for your OK before teaching.
- A proposition graph and plan trees.
- AI-generated demos and visuals (desktop only).
- Deepgram dictation, and ChatGPT/Copilot/Grok sign-in on desktop.

## Changes by PR

### Hosting and accounts

**#2: private web app** ([PR](https://github.com/thejackluo/learnharness/pull/2))
- LearnHarness can run as a web app from the same code as desktop.
- One owner only, with passphrase login, secure session cookies and rate limiting.
- A lock stops two server processes from writing your data at once.
- Includes a Docker container and CI (Windows, macOS, Linux and hosted-runtime builds).
- Desktop-only features (generated demos, local file and PDF tools, research) are switched off on the web.

**#14: ChatGPT subscription sign-in on the hosted app** ([PR](https://github.com/thejackluo/learnharness/pull/14))
- Sign-in uses a paste-back flow: you sign in at OpenAI, copy the failed `127.0.0.1` address and paste it into LearnHarness.
- The hosted app then runs on your ChatGPT plan, so it doesn't need an OpenAI API key or IP allowlist.

**Deployment (no PR):** on your Coolify server, with your data on a persistent volume, at https://learn.jack-luo.com. Tutoring models were switched to your ChatGPT subscription on 2026-11-12.

### More than multiple choice

**#3: mixed mode and multipart questions** ([PR](https://github.com/thejackluo/learnharness/pull/3))
- A new "mixed" assessment mode (multiple choice plus free response).
- Questions with several parts, each graded against its own criteria, with feedback per criterion.
- The server re-checks grading, so the browser can't forge a score.

**#13: subject-specific answer types** ([PR](https://github.com/thejackluo/learnharness/pull/13))
- Numbers with units and a tolerance (physics, for example).
- Exact recall, for vocab or kana.
- Labelled fill-in fields.

**#15: Python code exercises** ([PR](https://github.com/thejackluo/learnharness/pull/15))
- Your code runs in your browser (Pyodide) against real tests, with network access blocked.
- Code is scored from the test results.

**#17: code exercises in every chat** ([PR](https://github.com/thejackluo/learnharness/pull/17))
- "Mixed" is now the default.
- The tutor gets the code-exercise instructions from the first message.
- Fixed the Python runner, which hadn't worked in a real browser since #15.

### Knowing what you know

**#4: learner profile and imports** ([PR](https://github.com/thejackluo/learnharness/pull/4))
- A profile with your background, coursework, and topics rated unfamiliar / seen / practiced / confident.
- Import `.txt`/`.md` notes, which you review before anything is saved.
- Results from your chats become evidence that later chats see.

**#12: suggested familiarity** ([PR](https://github.com/thejackluo/learnharness/pull/12))
- "Find my level" placement runs, up to 15 checks.
- Inferring what you know from imported notes and from quotes in the conversation.
- Everything here is a **suggestion** until you confirm it.

### Subject maps and pathways

**#5: prerequisite maps** ([PR](https://github.com/thejackluo/learnharness/pull/5))
- Skills with "needs X first" links.
- Goal skills, with the gaps on the way to each goal and why each gap matters.
- Edit, import and export maps.

**#10: AI-drafted maps** ([PR](https://github.com/thejackluo/learnharness/pull/10))
- Draft a map from a goal, a framework (e.g. JLPT) or a syllabus.
- Each skill cites its source, and you accept the draft before it's saved.

**#11: "Metroidvania" pathways** ([PR](https://github.com/thejackluo/learnharness/pull/11))
- Keystone skills.
- "Any one of these" alternative routes.
- Each skill shown as cleared / open / reachable / locked on a world map.
- A route to your goal, with skip-ahead options.

**#18: maps from ordinary chats** ([PR](https://github.com/thejackluo/learnharness/pull/18))
- In any chat the tutor can offer "Use your OS map → Scheduling?" (Link / Not now), and switch the link when the topic changes.
- Only answers given after you click Link count toward that skill.
- For a subject with no map, it can offer "Draft a Japanese map?".

### Adapting to you

**#6: pacing and confidence** ([PR](https://github.com/thejackluo/learnharness/pull/6))
- Confidence ratings are optional.
- Conversational pacing.
- Sessions and practice focused on one skill, with results credited to that skill.

**#16: recurring weaknesses** ([PR](https://github.com/thejackluo/learnharness/pull/16))
- Tracks specific recurring weaknesses in any subject, e.g. "Python: off-by-one in range() bounds ×3".
- Each one quotes your own words or code as proof.
- The tutor sees your top 10 in every chat, and you can dismiss or resolve them in Settings → Learner.
- They never change what counts as mastered.

**#17** (also above): the tutor records weaknesses from the first message, and is reminded whenever your code fails a test.

**#19: talk-first opening** ([PR](https://github.com/thejackluo/learnharness/pull/19))
- The strict opening assessment is replaced by a conversation about what you're working on.
- The tutor uses your profile, maps, past results and weaknesses to guess your level.
- It asks at most 2–3 quick checks, often none, and only where it has no evidence.
- It then draws the plan map on the side and starts teaching in the same reply, without waiting for your OK. You can ask to change the plan any time.
- "Find my level" is unchanged.
- Deployed; not yet checked live, because your ChatGPT usage ran out.

### Visual and interactive teaching

**#7: interactive activities** ([PR](https://github.com/thejackluo/learnharness/pull/7)): a "compare cases" plot you explore and then explain. The app draws it from data, so it works on the web.

### Voice

**#8: read-aloud** ([PR](https://github.com/thejackluo/learnharness/pull/8)): reads replies and questions aloud using your device's voices when you press "Read reply". Talking stops it. It never reads answers or rubrics aloud.

### Other

**#20: clearer ChatGPT usage-limit error** ([PR](https://github.com/thejackluo/learnharness/pull/20)): when your plan runs out, the app says "usage limit reached" instead of a generic failure, and the server logs the real cause with secrets redacted.

**#1** ([PR](https://github.com/thejackluo/learnharness/pull/1)): a one-line test PR.

## Known gaps

- Dictation on the hosted app returns 503: there is no Deepgram key on the server.
- Only Python code runs. There's one interactive activity type so far, and no image or drawing answers.
- Weaknesses and suggestions deliberately never change routing or mastery.
- Only the code-exercise + weakness flow has been tested live with a real model on the hosted app.

## Planned next (in your order)

1. Answer formats: code editor with linting, math and Markdown answer boxes, table filling, whiteboard/diagram answers.
2. Voice last: hands-free voice conversation, plus listening and speaking questions.
