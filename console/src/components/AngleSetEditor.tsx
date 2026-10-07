import { Field } from "./Field";
import { AngleUploadCard } from "./AngleUploadCard";
import { MAX_ANGLES, newAngle, type AngleDraft, type DraftIssue, issuesFor } from "../programs/draft";
import { useUploadRunner } from "../upload/useUploadRunner";
import { initialUploadState, uploadStateReducer, type UploadEvent } from "../upload/uploadMachine";

interface Props {
  angles: AngleDraft[];
  /** Functional update so asynchronous upload progress never overwrites concurrent edits. */
  onChange: (update: (prev: AngleDraft[]) => AngleDraft[]) => void;
  issues?: DraftIssue[];
  issuePrefix?: string;
  disabled?: boolean;
  /** Human label for accessibility, e.g. "Season 1 episode 2". */
  context: string;
}

/**
 * Editable list of camera angles. Each angle is a name plus either an existing
 * uploadID or a ZIP pushed through the browser. Index 0 is the default angle.
 */
export function AngleSetEditor({ angles, onChange, issues = [], issuePrefix = "angles", disabled = false, context }: Props) {
  const runner = useUploadRunner();

  const update = (key: string, patch: Partial<AngleDraft>) =>
    onChange((prev) => prev.map((a) => (a.key === key ? { ...a, ...patch } : a)));
  const applyUploadEvent = (key: string, event: UploadEvent) =>
    onChange((prev) => prev.map((a) => (a.key === key ? { ...a, upload: uploadStateReducer(a.upload, event) } : a)));

  const move = (index: number, delta: number) => {
    onChange((prev) => {
      const target = index + delta;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      const [item] = next.splice(index, 1);
      next.splice(target, 0, item!);
      return next;
    });
  };

  const remove = (key: string) => {
    runner.cancel(key);
    onChange((prev) => prev.filter((a) => a.key !== key));
  };

  return (
    <div className="angles">
      {angles.map((angle, index) => {
        const prefix = `${issuePrefix}.${index}`;
        return (
          <fieldset key={angle.key} className="angle" data-testid="angle">
            <legend className="angle__legend">
              Angle {index + 1}
              {index === 0 && <span className="tag">default</span>}
            </legend>
            <div className="angle__grid">
              <Field label="Angle name" required error={issuesFor(issues, `${prefix}.name`)}>
                {(id, describedBy) => (
                  <input
                    id={id}
                    className="input"
                    value={angle.name}
                    maxLength={50}
                    disabled={disabled}
                    aria-describedby={describedBy}
                    placeholder="Main, Side, Overhead…"
                    onChange={(e) => update(angle.key, { name: e.target.value })}
                  />
                )}
              </Field>
              <Field label="Source">
                {(id) => (
                  <select
                    id={id}
                    className="input"
                    value={angle.source}
                    disabled={disabled}
                    onChange={(e) => {
                      const source = e.target.value as AngleDraft["source"];
                      if (source === "existing") runner.cancel(angle.key);
                      update(angle.key, { source });
                    }}
                  >
                    <option value="zip">Upload HLS ZIP</option>
                    <option value="existing">Existing uploadID</option>
                  </select>
                )}
              </Field>
            </div>
            {angle.source === "existing" ? (
              <Field label="uploadID" required error={issuesFor(issues, `${prefix}.uploadID`)} hint="A completed upload with status ready that is not attached to another episode.">
                {(id, describedBy) => (
                  <input
                    id={id}
                    className="input input--mono"
                    value={angle.existingUploadID}
                    disabled={disabled}
                    aria-describedby={describedBy}
                    placeholder="01890a5d-ac96-774b-b111-000000000801"
                    onChange={(e) => update(angle.key, { existingUploadID: e.target.value })}
                  />
                )}
              </Field>
            ) : (
              <>
                <AngleUploadCard
                  state={angle.upload}
                  disabled={disabled}
                  inputLabel={`${context} angle ${index + 1} archive`}
                  onFile={(file) => runner.start(angle.key, file, (event) => applyUploadEvent(angle.key, event))}
                  onCancel={() => runner.cancel(angle.key)}
                  onReset={() => update(angle.key, { upload: initialUploadState })}
                />
                {issuesFor(issues, `${prefix}.upload`) && angle.upload.phase !== "failed" && (
                  <p className="field__error">{issuesFor(issues, `${prefix}.upload`)}</p>
                )}
              </>
            )}
            <div className="angle__footer">
              <button type="button" className="btn btn--small btn--ghost" disabled={disabled || index === 0} onClick={() => move(index, -1)}>
                Move up
              </button>
              <button type="button" className="btn btn--small btn--ghost" disabled={disabled || index === angles.length - 1} onClick={() => move(index, 1)}>
                Move down
              </button>
              <button type="button" className="btn btn--small btn--danger-ghost" disabled={disabled || angles.length === 1} onClick={() => remove(angle.key)}>
                Remove angle
              </button>
            </div>
          </fieldset>
        );
      })}
      {issuesFor(issues, issuePrefix) && <p className="field__error">{issuesFor(issues, issuePrefix)}</p>}
      <button
        type="button"
        className="btn"
        disabled={disabled || angles.length >= MAX_ANGLES}
        onClick={() => onChange((prev) => [...prev, newAngle(prev.length === 0 ? "Main" : "")])}
      >
        Add angle ({angles.length}/{MAX_ANGLES})
      </button>
    </div>
  );
}
