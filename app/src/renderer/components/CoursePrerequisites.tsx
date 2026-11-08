import Html from './Html'

export default function CoursePrerequisites({ items }: { items?: string[] }) {
  if (!items?.length) return null
  return <section className="panel course-prerequisites">
    <h2>Before you start</h2>
    <ul>{items.map((item, i) => <Html as="li" key={i} lesson inline={!item.includes('\n')} source={item} />)}</ul>
  </section>
}
