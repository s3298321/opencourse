# Coach GPT-Live migration and release checks

Coach uses `gpt-live-1` for voice and `gpt-6-luna` for Responses delegation. The backend uses default reasoning, automatic tool choice and sequential calls. Its model is internal. Credentials and HTTP remain in Electron main; audio travels directly over WebRTC. There is no Realtime fallback, reconnect loop, recording storage or idle timeout.

Existing Realtime project models and default preferences migrate on access. SQLite and project mirrors are repaired independently, including recovered backup projects. Historical session models, briefs and legacy turns stay unchanged. Current conversations store original caption fragments and materialize the same independently grouped speaker bubbles used in the live view.

## Feature parity checklist

The previous Coach controller tests established the behavior below. Realtime turn-policy and response-gate fixtures are replaced by Live startup, local playback and delegated-response tests. Legacy reducer tests remain as regression fixtures, outside active execution paths.

| Behavior | Automated coverage |
| --- | --- |
| Microphone refusal, startup races, duplicate starts, ICE completion, late connection after Stop now, startup timeout | `coach-live.test.ts`, `coach-session.test.ts` |
| Continuous microphone, Stop speaking, no stale playback after work completes, learner speech plus output silence before resuming | `coach-live.test.ts`, `coach-audio.test.ts` |
| Custom brief, voices, separate prompts, model access errors and delayed backend rejection | `coach-live.test.ts`, `coach-session.test.ts`, `coach-tools.test.ts` |
| Completed function items, duplicate calls, separate response IDs, result submission and continuation, backend failure diagnostics | `coach-live.test.ts`, `coach-session.test.ts` |
| File path validation, deletion revocation, project locks, ownership and tool/search caps | `coach-files.test.ts`, `coach-tools.test.ts`, `coach-session.test.ts` |
| Memory writes, tool history and a second session reading the first session’s notes | `coach-session.test.ts`, `coach-pipeline.test.ts` |
| Overlapping and late captions, exact whitespace/repeated words, event deduplication, persistence retries and partial disconnect transcripts | `coach-live.test.ts`, `coach-db.test.ts` |
| Ten-second drain, two save attempts, forced second write, twenty-second save deadline, silent wrap-up, Stop now, five-second close timeout, 45-minute cap | `coach-live.test.ts` |
| Background navigation, live indicator and cleanup on removal | `coach-background.test.ts` |
| Migration, mirror repair, recovered projects, preference persistence, legacy history and transcript deletion | `coach-db.test.ts`, `coach-session.test.ts`, `sidechat-thread.test.ts` |

Run from `app/`, using the Node version in `package.json`:

```sh
npm run typecheck
npm test
npm run build
npm run smoke
```

Normal tests never call the real API. Passing mocked protocol tests is not sufficient for release.

## Real API gate

Build first. Set `OPENAI_API_KEY` in the environment and provide an absolute path in `OPENCOURSE_LIVE_AUDIO` to a WAV containing French speech, pauses and a request to remember learning progress. Do not put secrets or personal speech in the repository. Then run:

```sh
OPENCOURSE_TEST_COACH_LIVE=1 npm test -- tests/coach-live-api.test.ts
```

This billable check launches the actual Electron app with a disposable profile and uses the WAV as its microphone. It exercises the production WebRTC controller, both caption streams, delegated workspace writes, backend usage, silent note-saving and confirmed graceful close. A second session must read the note written by the first. The report includes check names and a failed phase, never API credentials, captions or note contents. Key/model listing checks remain available through `OPENCOURSE_TEST_OPENAI=1 npm test -- tests/openai-live.test.ts`.

A missing key or audio fixture is an outstanding check, not a passing result. The automated speech fixture does not verify physical microphone behavior.

## Manual microphone release gate

Run both with speakers and with headphones:

- Practise French, including short acknowledgments while the learner is speaking. Check both captions and historical transcript spacing.
- Interrupt naturally and use Stop speaking during research and a note write. Check that the microphone stays live, accepted writes finish once, and old speech never replays.
- Navigate to the learning workspace and back while speaking. Verify the indicator, timer, scroll position and continuing session.
- Finish during a tool call, then test Stop now. Check immediate local silence, stopped capture, saved notes or an honest save failure, and confirmed or explicitly unconfirmed finalization.
- Start a second session and verify the coach uses the notes from the first. Test a dropped connection and unavailable model access without automatic engine switching.

Release remains blocked until the real API gate and these hardware checks pass.

## Implementation references

The connection and lifecycle follow OpenAI’s [Live WebRTC guide](https://developers.openai.com/api/docs/guides/voice-webrtc?api=live), [Responses delegation guide](https://developers.openai.com/api/docs/guides/live-delegation), [playback controls](https://developers.openai.com/api/docs/guides/voice-server-controls?api=live) and [Live lifecycle guide](https://developers.openai.com/api/docs/guides/live-conversations).
