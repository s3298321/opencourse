/**
 * The accounts a development server is seeded with (server/scripts/seed.ts)
 * and that a `npm run dev` app signs in as (main/dev-seed.ts). One place, so
 * the two seeds cannot drift. Only ever meaningful against a server started
 * with OPENCOURSE_SERVER_DEV=1 - these are not secrets, they are fixtures.
 */
export const DEV_PASSWORD = 'correct horse battery'

/** Publishes docs/example-course and docs/example-document. */
export const DEV_AUTHOR = 'ada'
/** Publishes the committed fixture courses when OPENCOURSE_SEED_SAMPLES=1. */
export const DEV_SECOND_AUTHOR = 'grace'
/** Has added the example course: the app's learner. */
export const DEV_LEARNER = 'sam'
export const DEV_LEARNERS = ['lin', 'kit', DEV_LEARNER, 'noor'] as const

/** The fixture courses a dev profile imports and a sampled dev server publishes. */
export const DEV_SAMPLE_COURSES = ['intro-to-python', 'python-asyncio'] as const
