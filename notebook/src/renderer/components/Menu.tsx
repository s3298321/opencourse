import SharedMenu from '../../learning-ui/Menu'
import { useScreenActive } from '../screen-activity'
export type { MenuItem } from '../../learning-ui/Menu'
export default function Menu(props: Parameters<typeof SharedMenu>[0]) {
  return <SharedMenu {...props} screenActive={useScreenActive()} />
}
