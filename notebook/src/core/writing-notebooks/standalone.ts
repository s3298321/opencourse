/** A notebook the dedicated app shares with OpenCourse: no course, document, or coach link. */
export function isStandaloneNotebook(notebook: { association?: unknown }): boolean {
  return notebook.association == null
}
