import { useRef, useState } from 'react';
import { Button, Inline, InlinePopover } from '@connorhoehn/ui-components/shared';
import { SkillFilter } from './SkillFilter';
import { WeightSlider } from './WeightSlider';
import { DepartmentFilter } from './DepartmentFilter';

interface Props {
  skillFilter: string;
  onSkillChange: (skill: string) => void;
  weight: number;
  onWeightChange: (w: number) => void;
  departments: string[];
  deptFilter: string;
  onDeptChange: (d: string) => void;
}

// The one selector/filter row DEFECTS.md #3 asks for: skill search,
// weighting (behind a popover, not its own row) and department all sit on
// one line instead of the three stacked rows this page used to render.
export function FilterBar({
  skillFilter, onSkillChange, weight, onWeightChange, departments, deptFilter, onDeptChange,
}: Props) {
  const [weightOpen, setWeightOpen] = useState(false);
  const weightTriggerRef = useRef<HTMLSpanElement>(null);
  const infPct = Math.round(weight * 100);
  const expPct = 100 - infPct;

  return (
    <Inline align="center" gap="md" wrap className="mb-3">
      <SkillFilter selectedSkill={skillFilter} onChange={onSkillChange} />

      <Inline as="span" ref={weightTriggerRef} gap="none" className="inline-flex">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => setWeightOpen(o => !o)}
          aria-haspopup="dialog"
          aria-expanded={weightOpen}
        >
          Weighting: {infPct}% / {expPct}%
        </Button>
      </Inline>
      <InlinePopover
        trigger={weightTriggerRef}
        open={weightOpen}
        onClose={() => setWeightOpen(false)}
        aria-label="Composite weighting"
        className="w-[260px] p-3"
      >
        <WeightSlider value={weight} onChange={onWeightChange} />
      </InlinePopover>

      <DepartmentFilter departments={departments} selected={deptFilter} onChange={onDeptChange} />
    </Inline>
  );
}
