import { createContext, useContext } from 'react'
import type { QuoteSource } from '@core/types'

/**
 * An offer to ask the side chat about a passage: the floating "Ask about this"
 * button, and what pressing it attaches.
 *
 * The lesson or course editor makes these for text in its own window - its prose, and the side
 * chat's finished answers, which opt in with `data-ask`. A visualization makes
 * them for text selected inside its frame, which the lesson cannot see
 * (core/vizbridge.ts). Either way the screen owns the button, the quote and the
 * chat; the owner of the passage only knows how to mark it.
 */
export interface AskOffer {
  /** Who made the offer, so only they can take it back. */
  owner: object
  text: string
  /** What the model is told the passage is from. */
  from: QuoteSource
  /** Where to float the offer, in viewport coordinates: the passage's top centre. */
  x: number
  y: number
  /** Keep the passage visibly marked while the learner writes about it. */
  mark: () => void
  unmark: () => void
}

export interface Ask {
  /** Float the button for this passage, replacing any other offer. */
  offer: (offer: AskOffer) => void
  /** Take back an offer, if it is still this owner's. */
  withdraw: (owner: object) => void
  /** Skip the button: attach the passage and open the chat. */
  attach: (offer: AskOffer) => void
}

const noop = (): void => undefined

/** Outside a reading or authoring screen there is no chat to ask. */
const AskContext = createContext<Ask>({ offer: noop, withdraw: noop, attach: noop })

export const AskProvider = AskContext.Provider

export function useAsk(): Ask {
  return useContext(AskContext)
}
