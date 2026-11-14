/**
 * Whether a transcript window is close enough to the bottom to keep following
 * what is being said.
 *
 * This is in core for the same reason the reducer and the response gate are:
 * a live transcript needs a key, a socket and a microphone to appear at all, so
 * the one rule that is easy to get wrong would otherwise only ever be checked by
 * talking to it. The rule is an inequality over three numbers, and an inequality
 * over three numbers is a unit test.
 *
 * The slack matters. `scrollHeight - scrollTop - clientHeight` is rarely exactly
 * zero at the bottom: fractional line heights, a device pixel ratio that is not
 * 1, and the browser's own rounding all leave a pixel or two behind. Demanding
 * exactly zero means the window stops following itself the moment it starts, for
 * no reason the learner can see.
 */

/** Distance from the bottom that still counts as the bottom. */
export const NEAR_BOTTOM_PX = 24

export interface ScrollMetrics {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

export function atBottom(m: ScrollMetrics, slack: number = NEAR_BOTTOM_PX): boolean {
  return m.scrollHeight - m.scrollTop - m.clientHeight <= slack
}
