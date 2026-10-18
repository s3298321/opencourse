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

Release validation uses the automated suites above, CI, and the app build. All
checks run unattended without API keys, speech recordings, or physical microphone
checks. Provider transport and media devices use deterministic test doubles;
these checks validate application behavior, not external service availability or
hardware acoustics.

## Implementation references

The connection and lifecycle follow OpenAI’s [Live WebRTC guide](https://developers.openai.com/api/docs/guides/voice-webrtc?api=live), [Responses delegation guide](https://developers.openai.com/api/docs/guides/live-delegation), [playback controls](https://developers.openai.com/api/docs/guides/voice-server-controls?api=live) and [Live lifecycle guide](https://developers.openai.com/api/docs/guides/live-conversations).
