import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Dispatch, JSX, RefObject, SetStateAction } from 'react'
import { findLesson, lessonKey, itemSiblings } from '@core/manifest'
import { QUOTE_HIGHLIGHT } from '@core/vizbridge'
import type {
  ChatQuote,
  CourseProgress,
  CourseView,
  ExerciseBlock,
  CourseItemRef,
  QuizAttempt,
  QuoteSource,
  UserProfile
} from '@core/types'
import { renderBlock } from '../blocks'
import ExerciseBlockView from '../blocks/Exercise'
import Workbench from '../workbench/Workbench'
import SideChat from '../components/SideChat'
import Sidebar from '../components/Sidebar'
import TitleBar from '../components/TitleBar'
import LessonHeader from '../components/LessonHeader'
import { AskProvider, type Ask, type AskOffer } from '../ask-context'
import { itemRoute, type Route, type Screen } from '../routes'

interface Props {
  courseId: string
  moduleId: string
  lessonId: string
  user: UserProfile | null
  navigate: (r: Route) => void
  navSignal: { action: 'prev' | 'next'; n: number } | null
  route: Screen
  /** Lifted into App so a trip to settings does not close the panel. */
  chatOpen: boolean
  setChatOpen: Dispatch<SetStateAction<boolean>>
  /**
   * Also lifted, and tagged with the lesson it belongs to: a ref dies with the
   * component, and settings unmounts this one. The tag is what tells a remount
   * of the same lesson (restore it) from a move to another one (start at the
   * top) - the two used to be indistinguishable because only a mount happened.
   */
  scrollRef: RefObject<{ key: string; top: number }>
}

/** Marks a passage of text in this window (null clears it). See the comment on `attach`. */
function markPassage(range: Range | null): void {
  if (!('highlights' in CSS)) return
  if (range) CSS.highlights.set(QUOTE_HIGHLIGHT, new Highlight(range))
  else CSS.highlights.delete(QUOTE_HIGHLIGHT)
}

/**
 * What a selection can be asked about as, or null if it cannot be.
 *
 * A region opts in with `data-ask`: the lesson's column, and each finished
 * answer in the side chat. The whole selection has to sit inside one region,
 * so a drag from one answer across your own question into the next is not
 * offered as a quote of either - and an answer still streaming carries no
 * attribute, because the finished one replaces its nodes and would take the
 * mark with them.
 */
function askableAs(node: Node): QuoteSource | null {
  const element = node instanceof Element ? node : node.parentElement
  const from = element?.closest('[data-ask]')?.getAttribute('data-ask')
  return from === 'lesson' || from === 'answer' ? from : null
}

/** The owner of offers made for text in this window: the lesson's and the chat's. */
const PAGE_TEXT = {}

/**
 * How far the offer's centre keeps from the window's sides. The side chat is
 * flush with the right edge, so a word at the end of an answer's line would
 * otherwise centre half the button off screen.
 */
const OFFER_INSET = 64

export default function LessonView({
  courseId,
  moduleId,
  lessonId,
  user,
  navigate,
  navSignal,
  route,
  chatOpen,
  setChatOpen,
  scrollRef
}: Props): JSX.Element {
  const [course, setCourse] = useState<CourseView | null>(null)
  const [progress, setProgress] = useState<CourseProgress | null>(null)
  const [openExerciseId, setOpenExerciseId] = useState<string | null>(null)
  // What the learner has highlighted - in the lesson or inside a visualization -
  // and where to float the button offering to ask about it. Cleared when it is
  // used, dismissed, or the selection goes.
  const [selection, setSelection] = useState<AskOffer | null>(null)
  const [quote, setQuote] = useState<ChatQuote | null>(null)
  // Whichever passage is marked as the attached quote, so the one that is
  // marked is the one that gets unmarked - lesson text and frames alike.
  const marked = useRef<AskOffer | null>(null)
  // The lesson column is hidden, not unmounted, while the editor is open - so
  // its scroll offset has to be carried by hand. Chromium regenerates the box
  // on display:none and resets scrollTop to 0.
  const contentRef = useRef<HTMLDivElement | null>(null)
  // Held by App, because this component unmounts on the way to settings and a
  // ref of its own would take the reading position with it.
  const lessonScroll = scrollRef
  const here = `${courseId}/${moduleId}/${lessonId}`

  const activeLesson = useRef({ moduleId, lessonId })
  activeLesson.current = { moduleId, lessonId }
  useEffect(() => {
    let alive = true
    const refresh = (changed = false): void => { void window.opencourse.getCourse(courseId).then((next) => {
      if (!alive) return
      setCourse(next)
      if (changed) setOpenExerciseId(null)
      const here = activeLesson.current
      if (!next || !findLesson(next, here.moduleId, here.lessonId)) navigate({ name: 'library' })
    }) }
    refresh(); const off = window.opencourse.onCoursesChanged(() => refresh(true))
    return () => { alive = false; off() }
  }, [courseId])

  useEffect(() => {
    void window.opencourse.touchLesson(courseId, moduleId, lessonId).then(setProgress)
    // The workbench owns a shell bound to this lesson's exercise directory.
    setOpenExerciseId(null)
    // The offset is tagged with its lesson rather than cleared here: clearing
    // on mount cannot tell "you came back from settings" from "you moved to
    // another lesson", and zeroed both.
    // The chat deliberately survives: carrying a conversation between lessons
    // is the whole point of it. A highlight from the last lesson does not - but
    // a passage from one of the chat's answers is still on screen, and still
    // what it was.
    setSelection(null)
    setQuote((current) => (current?.from === 'answer' ? current : null))
  }, [courseId, moduleId, lessonId])

  const found = useMemo(
    () => (course ? findLesson(course, moduleId, lessonId) : undefined),
    [course, moduleId, lessonId]
  )
  const neighbours = useMemo(
    () => (course && found ? itemSiblings(course, moduleId, lessonId) : { prev: undefined, next: undefined }),
    [course, found]
  )

  const go = useCallback(
    (ref?: CourseItemRef) => {
      if (ref) navigate(itemRoute(courseId, ref))
    },
    [navigate, courseId]
  )

  // ⌘[ / ⌘] from the Course menu.
  useEffect(() => {
    if (!navSignal) return
    go(navSignal.action === 'prev' ? neighbours.prev : neighbours.next)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navSignal?.n])

  /**
   * Offer to ask about whatever was just highlighted, in the lesson or in one
   * of the chat's answers.
   *
   * Both are markdown injected as raw HTML with no per-node anchors, so the
   * selected string is all there is to capture - which is all the question
   * needs. Bound to the document rather than either, because a drag that ends
   * outside the text still finishes a selection.
   */
  useEffect(() => {
    const onUp = (event: MouseEvent): void => {
      // The release that presses the offer is not a new selection. Without this
      // the button unmounts between mouseup and click, and the click lands on
      // nothing - which is why pressing it appeared to do nothing at all.
      if ((event.target as HTMLElement | null)?.closest?.('.ask-about')) return
      const found = window.getSelection()
      const text = found?.toString().trim() ?? ''
      if (!found || !text || found.rangeCount === 0) return setSelection(null)
      const range = found.getRangeAt(0)
      const from = askableAs(range.commonAncestorContainer)
      if (!from) return setSelection(null)
      const box = range.getBoundingClientRect()
      if (!box.width && !box.height) return setSelection(null)
      const kept = range.cloneRange()
      setSelection({
        owner: PAGE_TEXT,
        text,
        from,
        x: box.left + box.width / 2,
        y: box.top,
        mark: () => markPassage(kept),
        unmark: () => markPassage(null)
      })
    }
    document.addEventListener('mouseup', onUp)
    return () => document.removeEventListener('mouseup', onUp)
  }, [])

  /**
   * Attach a passage and keep it marked while you write about it.
   *
   * The mark cannot be the ordinary selection: a document has exactly one, and
   * the side chat focuses its composer the moment it opens - which collapses
   * it. VSCode gets to keep an inactive editor selection; the web platform's
   * equivalent is a custom highlight, which is independent of focus and of the
   * selection, and is what both kinds of passage use. A visualization's is set
   * inside its own frame, because only the frame can see its text.
   */
  const attach = useCallback(
    (offer: AskOffer): void => {
      marked.current?.unmark()
      setQuote({ text: offer.text, from: offer.from })
      setChatOpen(true)
      // The offer goes, the mark stays: the passage you attached should still
      // be visible while you type the question about it, the way the editor
      // keeps its selection in Copilot chat.
      setSelection(null)
      offer.mark()
      marked.current = offer
    },
    [setChatOpen]
  )

  const ask = useMemo<Ask>(
    () => ({
      offer: setSelection,
      withdraw: (owner) => setSelection((current) => (current?.owner === owner ? null : current)),
      attach
    }),
    [attach]
  )

  // One owner for the mark: it exists exactly as long as the quote does, which
  // covers being sent, being dismissed, and changing lesson.
  useEffect(() => {
    if (quote) return
    marked.current?.unmark()
    marked.current = null
  }, [quote])
  useEffect(() => () => marked.current?.unmark(), [])

  const onQuizAnswered = useCallback((blockId: string, attempt: QuizAttempt) => {
    setProgress((p) => (p ? { ...p, quizAttempts: { ...p.quizAttempts, [blockId]: attempt } } : p))
  }, [])

  const onExerciseToggled = useCallback(
    (blockId: string, done: boolean) => {
      void window.opencourse.setExerciseDone(courseId, blockId, done).then(setProgress)
    },
    [courseId]
  )

  /**
   * Opening the editor replaces the lesson column with the exercise's brief and
   * the editor, so the lesson goes off screen. Remember where it was: coming
   * back should land on the exercise you were doing, not at the top of it.
   */
  const openWorkbench = useCallback(
    (blockId: string) => {
      lessonScroll.current = { key: here, top: contentRef.current?.scrollTop ?? 0 }
      setSelection(null)
      setOpenExerciseId(blockId)
    },
    [here, lessonScroll]
  )

  const workbenchTarget = useMemo(
    () => (openExerciseId ? { courseId, blockId: openExerciseId } : null),
    [courseId, openExerciseId]
  )

  const openExercise = useMemo(() => {
    if (!openExerciseId || !found) return undefined
    return found.lesson.blocks.find(
      (b): b is ExerciseBlock => b.type === 'exercise' && b.id === openExerciseId
    )
  }, [openExerciseId, found])

  // Before paint, so the lesson does not flash at the top on the way back.
  useLayoutEffect(() => {
    if (openExerciseId !== null) return
    const el = contentRef.current
    if (!el) return
    // An offset belonging to a different lesson is not a position in this one.
    const want = lessonScroll.current.key === here ? lessonScroll.current.top : 0
    el.scrollTop = want
    if (want === 0 || el.scrollTop >= want) return

    // Still short of it: on a fresh mount the column is not its final height
    // yet - images have no dimensions and the sandboxed iframe is still empty -
    // so the browser clamps the offset to whatever fits, and coming back from
    // settings lands you above where you were reading. Keep asking until the
    // lesson is tall enough to hold it, and give up rather than fight forever.
    let frames = 0
    let raf = requestAnimationFrame(function retry(): void {
      const node = contentRef.current
      if (!node || frames++ > 40) return
      node.scrollTop = want
      if (node.scrollTop < want) raf = requestAnimationFrame(retry)
    })
    return () => cancelAnimationFrame(raf)
    // course *and* progress: the column is not rendered until both have
    // arrived, and whichever lands second is the render that first has an
    // element to scroll.
  }, [openExerciseId, course, progress, here, lessonScroll])

  if (!course || !progress) return <div className="empty">Loading…</div>
  if (!found) return <div className="empty">That lesson is not in this course.</div>

  const { lesson, ref } = found
  // The editor replaces the lesson column with the exercise's brief and the
  // code, and the chat has no lesson on screen to be about while it is open.
  const editorOpen = openExercise !== undefined && workbenchTarget !== null
  const completed = progress.completedLessons.includes(lessonKey(moduleId, lessonId))

  return (
    <>
      <TitleBar
        user={user}
        navigate={navigate}
        route={route}
        actions={
          !editorOpen && (
            <button
              className={`ghost chat-chip${chatOpen ? ' on' : ''}`}
              aria-pressed={chatOpen}
              title={chatOpen ? 'Close the side chat' : 'Ask about this lesson'}
              onClick={() => setChatOpen((open) => !open)}
            >
              Ask
            </button>
          )
        }
        back={{ label: 'All courses', onClick: () => navigate({ name: 'library' }) }}
      />
      <div className="body">
        <Sidebar
          course={course}
          current={{ moduleId, lessonId }}
          progress={progress}
          navigate={navigate}
        />
        <div
          className="content scroll"
          hidden={editorOpen}
          ref={contentRef}
          // Recorded as it happens rather than on the way out: by the time an
          // unmount runs there is no element left to ask. Not while the editor
          // is open, though - hiding the column resets scrollTop to 0 and
          // fires for it, which would erase the offset being saved.
          onScroll={(e) => {
            if (!editorOpen) lessonScroll.current = { key: here, top: e.currentTarget.scrollTop }
          }}
        >
          <div className="content-inner" data-ask="lesson">
            <LessonHeader lesson={lesson} index={ref.index} total={course.flatLessons.length} />

            {/* A visualization offers its own selections through this. */}
            <AskProvider value={ask}>
              {lesson.blocks.map((block, i) =>
                renderBlock(block, i, {
                  courseId: courseId,
                  moduleId,
                  lessonId,
                  progress,
                  onQuizAnswered,
                  onExerciseToggled,
                  onOpenWorkbench: openWorkbench,
                  openExerciseId
                })
              )}
            </AskProvider>

            <div className="lesson-nav">
              <button
                className={completed ? 'secondary' : ''}
                onClick={() => void window.opencourse.toggleLesson(courseId, moduleId, lessonId).then(setProgress)}
              >
                {completed ? '✓ Lesson completed' : 'Mark lesson completed'}
              </button>
            </div>

            <div className="lesson-nav">
              {neighbours.prev ? (
                <button className="secondary" onClick={() => go(neighbours.prev)}>
                  ← {neighbours.prev.title}
                </button>
              ) : (
                <span />
              )}
              <span className="spacer" />
              {neighbours.next && (
                <button onClick={() => go(neighbours.next)}>{neighbours.next.title} →</button>
              )}
            </div>
          </div>
        </div>
        {chatOpen && !editorOpen && (
          <SideChat
            courseId={courseId}
            lesson={{ moduleId, lessonId }}
            quote={quote}
            onQuoteUsed={() => setQuote(null)}
            onClose={() => setChatOpen(false)}
            onAddKey={() => navigate({ name: 'settings', from: route })}
          />
        )}
        {editorOpen && openExercise && workbenchTarget && (
          <Workbench
            key={`${courseId}/${openExercise.id}`}
            target={workbenchTarget}
            title={openExercise.title}
            lastRun={progress.exercises[openExercise.id]?.lastRun}
            starterCode={openExercise.starter_code ?? '# your code here\n'}
            brief={
              <ExerciseBlockView
                mode="brief"
                courseId={courseId}
                block={openExercise}
                done={Boolean(progress.exercises[openExercise.id]?.completedAt)}
                onToggleDone={onExerciseToggled}
              />
            }
            onClose={() => setOpenExerciseId(null)}
            onProgress={setProgress}
          />
        )}
      </div>
      {selection && (
        <button
          className="ask-about"
          style={{
            left: Math.min(Math.max(selection.x, OFFER_INSET), window.innerWidth - OFFER_INSET),
            top: selection.y
          }}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => attach(selection)}
        >
          Ask about this
        </button>
      )}
    </>
  )
}
