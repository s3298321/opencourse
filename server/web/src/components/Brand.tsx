/** The mark beside the wordmark, exactly as the app's titlebar shows it. */
export function Brand() {
  return (
    <a href="https://opencourse.dev/" className="oc-brand" aria-label="OpenCourse home">
      <img src="/mark-64.png" alt="" width={25} height={25} />
      <span>OpenCourse</span>
    </a>
  )
}

/**
 * The mark's four-point stars, scattered and twinkling slowly. Purely
 * decorative; positions come from the stylesheet (`.sparkles > :nth-child`), so
 * no element carries an inline style.
 */
export function Sparkles({ count = 7, className = '' }: { count?: number; className?: string }) {
  return (
    <div className={`sparkles ${className}`} aria-hidden="true">
      {Array.from({ length: count }, (_, i) => <span key={i} className="oc-sparkle oc-twinkle" />)}
    </div>
  )
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return <span className="spinner" role="status" aria-label={label}><span className="oc-sparkle oc-spinner" /></span>
}
