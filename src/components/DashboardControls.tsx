import type { ReactNode } from "react";

type SegmentOption<T extends string> = { value: T; label: ReactNode };

function GroupHeading({ eyebrow, title, titleId }: { eyebrow: string; title: ReactNode; titleId?: string }) {
  return <div className="group-heading"><span className="control-label">{eyebrow}</span><h2 id={titleId}>{title}</h2></div>;
}

function SegmentedControl<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly SegmentOption<T>[];
  onChange: (value: T) => void;
}) {
  return <div className="segmented" role="group" aria-label={label}>
    {options.map((option) => <button key={option.value} type="button" aria-pressed={value === option.value} className={value === option.value ? "selected" : ""} onClick={() => onChange(option.value)}>{option.label}</button>)}
  </div>;
}

function ToggleRow({
  label,
  description,
  checked,
  onChange,
  ariaLabel,
}: {
  label: ReactNode;
  description?: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  ariaLabel?: string;
}) {
  return <label className="toggle-row" aria-label={ariaLabel}>
    <span><strong>{label}</strong>{description && <small>{description}</small>}</span>
    <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
    <i />
  </label>;
}

export { GroupHeading, SegmentedControl, ToggleRow };
