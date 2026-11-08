import { darkSketchColors, sketchAssetPattern, type Sketch, type SketchColors } from '@core/writing-notebooks/sketch'

export function currentSketchColors(): SketchColors {
  const css = getComputedStyle(document.documentElement)
  return { background: css.getPropertyValue('--sketch-background').trim() || darkSketchColors.background,
    brush: css.getPropertyValue('--sketch-brush').trim() || darkSketchColors.brush }
}

/** Each Markdown version is immutable. Undo and copied references can still read older versions. */
export class SketchAssets {
  private drafts = new Map<string, { model: Sketch; colors: SketchColors }>()
  private reads = new Map<string, Promise<Sketch> | Sketch>()
  private writes = new Map<string, Promise<void>>()
  constructor(private notebookId: string) {}

  stage(model: Sketch): string {
    const asset = `assets/${crypto.randomUUID()}.sketch.svg`
    this.drafts.set(asset, { model, colors: currentSketchColors() })
    return asset
  }
  cached(asset: string): Sketch | undefined {
    const value = this.drafts.get(asset)?.model ?? this.reads.get(asset)
    return value && 'version' in value ? value : undefined
  }
  load(asset: string): Promise<Sketch> {
    const cached = this.cached(asset) ?? this.reads.get(asset)
    if (cached) return Promise.resolve(cached)
    const task = window.opencourse.writing.readSketch(this.notebookId, asset).then(model => {
      this.reads.set(asset, model)
      return model
    }).catch(error => {
      this.reads.delete(asset)
      throw error
    })
    this.reads.set(asset, task)
    return task
  }
  private persist(asset: string): Promise<void> | undefined {
    const draft = this.drafts.get(asset)
    if (!draft) return
    let task = this.writes.get(asset)
    if (!task) {
      task = window.opencourse.writing.saveSketch(this.notebookId, asset, draft.model, draft.colors).then(() => {
        this.drafts.delete(asset)
        this.reads.set(asset, draft.model)
      }).finally(() => this.writes.delete(asset))
      this.writes.set(asset, task)
    }
    return task
  }
  async flush(markdown: string): Promise<void> {
    if (!this.drafts.size) return
    const refs = new Set(markdown.match(new RegExp(sketchAssetPattern, 'g')))
    await Promise.all([...refs].map(asset => this.persist(asset)))
  }
}
