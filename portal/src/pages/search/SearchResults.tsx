import type { ComponentProps } from 'react';
import { RecordResultList } from '@connorhoehnslalom/ui-components';

/** Keep the native typed rows, checkboxes, marks and real navigation links. */
export function SearchResults(props: ComponentProps<typeof RecordResultList>) {
  return <RecordResultList {...props} className={[
    '[&_h2>span>span:first-child]:text-sm [&_h2>span>span:last-child]:text-xs',
    '[&_[data-record-key]]:py-2.5 [&_[data-record-key]_a]:font-semibold',
    '[&_[data-record-key]_.line-clamp-2]:text-xs',
    '[&>div:not(:first-child)]:text-xs', props.className,
  ].filter(Boolean).join(' ')} />;
}
