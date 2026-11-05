'use client';

/** Sort order; changes submit the small form it lives in. */
export function SortSelect({
  label,
  value,
  options,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
}) {
  return (
    <label className="sort">
      <span className="visually-hidden">{label}</span>
      <select
        name="sort"
        defaultValue={value}
        onChange={(e) => e.currentTarget.form?.requestSubmit()}
        aria-label={label}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
