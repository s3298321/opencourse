# Coach GPT-Live migration and release checks

Coach uses `gpt-live-1` for voice and `gpt-6-luna` for Responses delegation. Settings supplies shared model and reasoning choices for every coach at the start of each conversation; those choices remain fixed until that conversation ends. Model default omits an explicit reasoning effort. Tool choice is automatic and calls are sequential. The model manages its private workspace files; users have no file browser or session-history interface. Credentials and HTTP remain in Electron main; audio travels directly over WebRTC. There is no Realtime fallback, reconnect loop, recording storage or idle timeout.

Existing Realtime project models and default preferences migrate on access. SQLite and project mirrors are repaired independently, including recovered backup projects. Historical session models, briefs and legacy turns stay unchanged. Current conversations store original caption fragments and materialize the same independently grouped speaker bubbles used in the live view.

## Floating interface

The button above Notebooks morphs into the same floating surface. It lists coaches,
creates them through a name popup, and opens a live conversation in place. The
shell owns the session independently of panel visibility and navigation. One
conversation can run at a time; ending stops audio immediately, then saves memory.
Settings → Appearance can hide the button, finishing any conversation first.
Only the transcript scrolls. Running tools appear beside End conversation in a
single truncated line, with a count for additional calls; finished calls disappear.
End conversation stays disabled while memory is saving.

Backend failures clear the waiting indicator even when Live reports only an
uncorrelated session error, without a terminal response event. The conversation
shows a warning and sends one failure update to the voice model so the learner
does not have to speak to discover the failure. Existing tools can settle, but
failed turns are not automatically continued or replayed. Late terminal events
still contribute usage; unrelated correlated command errors leave active work
alone. Failure updates stay silent during wrap-up.

Coaches have no content association. Both models are instructed to use
`get_app_context` when the learner refers to what is open or selected, and to
refresh it after navigation. The backend receives a fresh, bounded response
from app-owned renderer windows, starting with the focused window and following
`nextCursor` for other windows. Context includes the active screen, course and
lesson IDs, PDF page, open Python and writing notebooks, selections, and short
notebook/lesson excerpts. Hidden reader screens do not report an active selection.
CodeMirror selections are read from editor state, including offscreen ranges.

`list_learning_sources` and `list_learning_content` discover local sources,
server libraries (including held unlisted versions), and catalogs. Source tools
accept explicit local IDs or server connection/ID/version references. Server
reading is authenticated, read-only, and checks the same visibility rules as
adding content, without creating an enrollment or local download. The server
must include the `/learn/:kind/:id/:version/read` endpoint; older servers return
an unavailable-tool error, while local content remains readable. Quiz keys and
exercise solutions are excluded from source retrieval.

Notebook discovery spans every notebook owned by the selected user, independent
of notebook associations. Reads of open notebook pages and Python cells use
current editor text, including unsaved edits; closed pages use saved revisions.
Notebook search identifies its saved-text scope. A nonresponding open editor
returns an explicit error instead of silently substituting saved text. Context
requests are correlated by nonce and sender; closed/reloaded windows cancel the
request, timeouts are reported, and switching users discards pending results.

The nullable schema-27 association column is ignored for compatibility with
earlier development builds. Coach associations are absent from types, UI,
recovery normalization, prompts, and tool authorization; memory and history
remain intact. Notebook chat still cannot browse private coach files or saved
transcripts through legacy notebook associations.

Automated coverage: `coach-reading.test.ts`, `coach-context.test.ts`,
`coach-context-renderer.test.ts`, `coach-background.test.ts`, and the server's
`learning.test.ts`. Automated provider and voice checks use deterministic test doubles.

## Feature parity checklist

The previous Coach controller tests established the behavior below. Realtime turn-policy and response-gate fixtures are replaced by Live startup, local playback and delegated-response tests. Legacy reducer tests remain as regression fixtures, outside active execution paths.

| Behavior | Automated coverage |
| --- | --- |
| Microphone refusal, startup races, duplicate starts, ICE completion, late connection after Stop now, startup timeout | `coach-live.test.ts`, `coach-session.test.ts` |
| Continuous microphone, spoken interruptions, no stale playback after work completes, learner speech plus output silence before resuming | `coach-live.test.ts`, `coach-audio.test.ts` |
| Custom brief, voices, separate prompts, selected background reasoning, model access errors and delayed backend rejection | `coach-live.test.ts`, `coach-session.test.ts`, `coach-tools.test.ts` |
| Completed function items, duplicate calls, separate response IDs, result submission and continuation, backend failure diagnostics | `coach-live.test.ts`, `coach-session.test.ts` |
| File path validation, deletion revocation, project locks, ownership and tool/search caps | `coach-files.test.ts`, `coach-tools.test.ts`, `coach-session.test.ts` |
| Memory writes, tool history and a second session reading the first session’s notes | `coach-session.test.ts`, `coach-pipeline.test.ts` |
| Overlapping and late captions, exact whitespace/repeated words, event deduplication, persistence retries and partial disconnect transcripts | `coach-live.test.ts`, `coach-db.test.ts` |
| Ten-second drain, two save attempts, forced second write, twenty-second save deadline, silent wrap-up, Stop now, five-second close timeout, 45-minute cap | `coach-live.test.ts` |
| Floating panel, navigation, collapse/reopen, visibility, start cancellation, running tool indicators, disabled saving controls and cleanup | `coach-background.test.ts`, `coach-smoke.ts` |
| Associations, document/course retrieval, notebook scoping and revisions, schema migration, per-user visibility | `coach-reading.test.ts` |
| Migration, mirror repair, recovered projects, preference persistence, legacy history and transcript deletion | `coach-db.test.ts`, `coach-session.test.ts`, `sidechat-thread.test.ts` |

Run from `app/`, using the Node version in `package.json`:

```sh
npm run typecheck
npm test
npm run build
OPENCOURSE_SMOKE_ONLY=coach,writing,workspaces npm run smoke
```

Release validation uses the automated suites above, CI, and the app build. All
checks run unattended without API keys, speech recordings, or physical microphone
checks. Provider transport and media devices use deterministic test doubles;
these checks validate application behavior, not external service availability or
hardware acoustics.

## Implementation references

The connection and lifecycle follow OpenAI’s [Live WebRTC guide](https://developers.openai.com/api/docs/guides/voice-webrtc?api=live), [Responses delegation guide](https://developers.openai.com/api/docs/guides/live-delegation), [playback controls](https://developers.openai.com/api/docs/guides/voice-server-controls?api=live) and [Live lifecycle guide](https://developers.openai.com/api/docs/guides/live-conversations).
