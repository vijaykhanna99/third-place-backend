import { useRef } from "react";
import { formatBytes, formatDuration } from "../lib/format";
import { isUploadActive, uploadProgressFraction, uploadStateLabel, type UploadState } from "../upload/uploadMachine";

interface Props {
  state: UploadState;
  disabled?: boolean;
  onFile: (file: File) => void;
  onCancel: () => void;
  onReset: () => void;
  inputLabel: string;
}

/** File picker + live progress for one camera-angle ZIP. */
export function AngleUploadCard({ state, disabled = false, onFile, onCancel, onReset, inputLabel }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const fraction = uploadProgressFraction(state);
  const active = isUploadActive(state);
  const pickable = state.phase === "idle" || state.phase === "cancelled" || state.phase === "failed";

  return (
    <div className={`upload-card upload-card--${state.phase}`} data-phase={state.phase}>
      <input
        ref={inputRef}
        type="file"
        accept=".zip,application/zip"
        className="visually-hidden"
        aria-label={inputLabel}
        disabled={disabled || !pickable}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onFile(file);
          e.target.value = "";
        }}
      />
      <div className="upload-card__head">
        <div>
          <span className="upload-card__status">{uploadStateLabel(state)}</span>
          {"fileName" in state && state.fileName && (
            <span className="upload-card__file">
              {state.fileName}
              {"byteSize" in state && typeof state.byteSize === "number" ? ` · ${formatBytes(state.byteSize)}` : ""}
            </span>
          )}
        </div>
        <div className="upload-card__actions">
          {pickable && (
            <button type="button" className="btn btn--small" disabled={disabled} onClick={() => inputRef.current?.click()}>
              {state.phase === "idle" ? "Choose ZIP" : "Choose another ZIP"}
            </button>
          )}
          {active && (
            <button type="button" className="btn btn--small" onClick={onCancel}>
              Cancel
            </button>
          )}
          {state.phase === "ready" && (
            <button type="button" className="btn btn--small btn--ghost" disabled={disabled} onClick={onReset}>
              Replace
            </button>
          )}
        </div>
      </div>
      {active && (
        <progress className="upload-card__bar" max={1} {...(fraction === null ? {} : { value: fraction })} aria-label={uploadStateLabel(state)} />
      )}
      {state.phase === "uploading" && (
        <p className="upload-card__detail">
          {formatBytes(state.bytesSent)} of {formatBytes(state.byteSize)}
        </p>
      )}
      {state.phase === "ready" && (
        <p className="upload-card__detail">
          uploadID <code>{state.uploadID}</code>
          {state.durationSec !== null && <> · duration {formatDuration(state.durationSec)}</>}
        </p>
      )}
      {state.phase === "failed" && (
        <p className="upload-card__detail upload-card__detail--error" role="alert">
          {state.error}
          {state.uploadID && (
            <>
              {" "}
              (uploadID <code>{state.uploadID}</code>)
            </>
          )}
        </p>
      )}
    </div>
  );
}
