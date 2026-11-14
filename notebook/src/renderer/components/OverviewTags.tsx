export default function OverviewTags({ tags }: { tags?: string[] }) {
  if (!tags?.length) return null
  return <ul className="overview-tags" aria-label="Tags">
    {tags.map((tag, index) => <li className="tag" key={index}>{tag}</li>)}
  </ul>
}
