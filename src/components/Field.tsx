import type { ReactNode } from "react";

export const Field = ({
  label,
  children,
  wide = false,
  hint,
}: {
  label: string;
  children: ReactNode;
  wide?: boolean;
  hint?: string;
}) => (
  <div className={`field${wide ? " wide" : ""}`}>
    <span>{label}</span>
    {children}
    {hint ? <small>{hint}</small> : null}
  </div>
);
