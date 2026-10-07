import { useRef, useState } from "react";
import { useApi } from "../api/ApiContext";
import { describeError } from "../api/client";
import { Field } from "./Field";

interface Props {
  label?: string;
  value: string;
  onChange: (url: string) => void;
  required?: boolean;
  error?: string | null;
}

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** URL input plus an "upload image" button that posts to /uploads/images and fills the URL. */
export function ThumbnailField({ label = "Thumbnail", value, onChange, required = false, error }: Props) {
  const api = useApi();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const onFile = async (file: File) => {
    setUploadError(null);
    if (!["image/jpeg", "image/png"].includes(file.type)) {
      setUploadError("Only JPEG or PNG images are accepted.");
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      setUploadError("Images are limited to 10 MB.");
      return;
    }
    setBusy(true);
    try {
      const result = await api.uploads.uploadImage(file);
      onChange(result.url);
    } catch (err) {
      setUploadError(describeError(err));
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  return (
    <Field label={label} required={required} error={error ?? uploadError} hint="Paste an https URL or upload a JPEG/PNG (max 10 MB).">
      {(id, describedBy) => (
        <div className="thumb-field">
          <div className="thumb-field__row">
            <input
              id={id}
              type="url"
              inputMode="url"
              className="input"
              placeholder="https://…"
              value={value}
              aria-describedby={describedBy}
              onChange={(e) => onChange(e.target.value)}
            />
            <input
              ref={inputRef}
              type="file"
              accept="image/jpeg,image/png"
              className="visually-hidden"
              aria-label={`${label} file`}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void onFile(file);
              }}
            />
            <button type="button" className="btn" disabled={busy} onClick={() => inputRef.current?.click()}>
              {busy ? "Uploading…" : "Upload image"}
            </button>
          </div>
          {value && /^https?:\/\//.test(value) && (
            <img className="thumb-field__preview" src={value} alt="" onError={(e) => (e.currentTarget.style.display = "none")} />
          )}
        </div>
      )}
    </Field>
  );
}
