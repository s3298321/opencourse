import Html from './Html'

export default function Objectives({ title, objectives }: { title: string; objectives?: string[] }) {
  if (!objectives?.length) return null
  return <div className="objectives">
    <h2>{title}</h2>
    <ul>{objectives.map((objective, i) => <Html as="li" key={i} lesson source={objective} />)}</ul>
  </div>
}
