interface Props {
  label?: string;
  fullPage?: boolean;
}

export function Loading({ label = "Loading…", fullPage = false }: Props) {
  return (
    <div className={fullPage ? "loading loading--page" : "loading"} role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}
