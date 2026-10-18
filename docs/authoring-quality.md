# Course authoring: research and teaching quality

Course authoring offers hosted web search by default, independently of learner chat. Settings → AI → Course authoring web search disables it. The model chooses when to use search; the prompt requires official documentation checks before adding or substantively changing version-sensitive technology instructions. The selected connection handles requests. Unsupported models continue without search with an author-facing notice.

Research is available during creation and editing. Current stable versions are the default for new courses, subject to runtime compatibility. Existing or explicitly pinned versions are preserved. Missing documentation is disclosed in the authoring chat rather than represented as verified. Transport failures preserve edits and require normal recovery; only an initial, specific unsupported-search rejection can retry without search.

Lessons use explanatory prose, concrete examples and purposeful practice. Research citations and consulted URLs are retained in the authoring conversation, not added to lesson content or exports, except image credits: original source/author/license attribution belongs beside the image and persists in the course archive. Consulted URLs indicate retrieval, not proof that every page supports a claim. Course schema validation is not an assessment of pedagogical quality or evidence that code was executed.

## Prompt design references

The prompt is original project text informed by these references, reviewed 2026-10-15:

- [Carpentries lesson design](https://carpentries.github.io/lesson-development-training/lesson-design.html): learner outcomes, aligned assessment, then explanatory content.
- [Carpentries explanatory writing](https://carpentries.github.io/lesson-development-training/explanation.html): self-directed learners need sufficient connecting prose; unnecessary detail increases cognitive load.
- [LessonBench lesson-planning example](https://github.com/SuienS/lesson-bench-v1/blob/main/prompts/LessonPlan_Creation_prompt.md): audience, prerequisites, conceptual progression and misconceptions. This is a design example, not validation of model teaching quality.
- [study.skill research guidance](https://github.com/SugarMGP/study.skill/blob/main/references/phase-1-research.md) and [teaching patterns](https://github.com/SugarMGP/study.skill/blob/main/references/teaching-patterns.md): official documentation, concrete examples before abstraction, and techniques selected for the subject. We do not import its approval gates, format or mandatory patterns.
- [OpenAI prompt engineering](https://developers.openai.com/api/docs/guides/prompt-engineering): separate role, instructions, examples and context, then evaluate outcomes.
- [OpenAI web search](https://developers.openai.com/api/docs/guides/tools-web-search): automatic tool choice, clickable citations and `web_search_call.action.sources` for consulted URLs.

## Automated validation

Tests use mocked transport and temporary course storage, run unattended, and require
no API keys or human scoring. Run from `app/` using the supported Node version:

```sh
npm test -- tests/authoring.test.ts tests/authoring-research.test.ts tests/project-agent.test.ts tests/project-files.test.ts tests/project-stream.test.ts
```

These suites cover authoring tools, research handling, project file access and
streaming behavior. Course schema validation checks structure; it does not establish
the teaching quality or factual accuracy of arbitrary model-generated lessons.
Release acceptance uses automated tests, CI and builds.

## Purposeful visuals and credited images

Authoring proactively chooses HTML visualizations for ideas, relationships and behavior,
and images for context, examples and identification. There is no per-lesson quota.
Small edits preserve scope. HTML bundles and imported image bytes remain available offline.
Search enables OpenAI image results only for authoring, with a maximum of five results per
search; stored metadata is sanitized, deduplicated and bounded to twenty images per turn.
Original source pages must establish reusable terms before `import_image` is used. Prefer
public-domain, CC0, CC BY and CC BY-SA images; skip unknown terms and never invent credits.
The import tool requires a license/public-domain designation, but that metadata is an
authoring assertion, not an automated legal determination. Inspect its supporting source.

The request supports API-key and ChatGPT connections. An initial explicit rejection of
image-search options retries once with ordinary text research. Other failures, or failures
after output or tool execution, do not replay edits. Disabling authoring search disables
image search too. The assistant can still use existing course assets and generated SVG/HTML.

Format 1.8 clients and servers must be released together: servers retain the existing rule
that new publications use the current archive format, while legacy archives remain importable.
