import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { useApi } from "../api/ApiContext";
import { streamUploadID } from "../api/streams";
import type { Episode, Genre, Program, Season, UpdateEpisodeInput, UpdateProgramRequest } from "../api/types";
import { AngleSetEditor } from "../components/AngleSetEditor";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { EmptyState } from "../components/EmptyState";
import { ErrorBanner, SuccessBanner } from "../components/ErrorBanner";
import { Field } from "../components/Field";
import { GenreMultiSelect } from "../components/GenreMultiSelect";
import { Loading } from "../components/Loading";
import { ThumbnailField } from "../components/ThumbnailField";
import { formatDateTime, formatDuration, isoToLocalInput, localInputToISO } from "../lib/format";
import { localKey } from "../lib/ids";
import { DESCRIPTION_MAX, TITLE_MAX, anglesToStreams, isHttpURL, validateAngles, type AngleDraft } from "../programs/draft";
import { initialUploadState } from "../upload/uploadMachine";

export function ProgramEditorPage() {
  const { id = "" } = useParams();
  const api = useApi();
  const navigate = useNavigate();
  const location = useLocation();
  const justCreated = (location.state as { created?: boolean } | null)?.created === true;
  const [program, setProgram] = useState<Program | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [genres, setGenres] = useState<Genre[]>([]);
  const [reload, setReload] = useState(0);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(justCreated ? "Program created." : null);

  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    Promise.all([api.catalog.getProgram(id, controller.signal), api.catalog.listGenres(controller.signal).catch(() => ({ genres: [] }))])
      .then(([p, g]) => {
        setProgram(p);
        setGenres(g.genres);
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setError(err);
      });
    return () => controller.abort();
  }, [api, id, reload]);

  const deleteProgram = async () => {
    setDeleting(true);
    setDeleteError(null);
    try {
      await api.cms.deleteProgram(id);
      navigate("/", { replace: true });
    } catch (err) {
      setDeleteError(err);
      setDeleting(false);
      setConfirmDelete(false);
    }
  };

  if (error !== null) {
    return (
      <>
        <ErrorBanner error={error} title="Could not load the program" onRetry={() => setReload((n) => n + 1)} />
        <Link to="/">Back to the dashboard</Link>
      </>
    );
  }
  if (program === null) return <Loading label="Loading program…" fullPage />;

  return (
    <>
      <div className="page__head">
        <div>
          <p className="crumbs">
            <Link to="/">Catalog</Link> / <span>{program.title}</span>
          </p>
          <h1>{program.title}</h1>
          <p className="muted">
            Created {formatDateTime(program.createdAt)} · updated {formatDateTime(program.updatedAt)} · {program.viewCount} plays · owner @{program.owner.handle}
          </p>
        </div>
        <button type="button" className="btn btn--danger" onClick={() => setConfirmDelete(true)}>
          Delete program
        </button>
      </div>
      {notice && <SuccessBanner onDismiss={() => setNotice(null)}>{notice}</SuccessBanner>}
      {deleteError !== null && <ErrorBanner error={deleteError} title="Delete failed" onDismiss={() => setDeleteError(null)} />}

      <div className="stack">
        <ProgramDetailsForm
          program={program}
          genres={genres}
          onSaved={(next) => {
            setProgram(next);
            setNotice("Program saved.");
          }}
        />
        {program.season.length === 0 && <EmptyState title="No seasons">This program has no episodes left.</EmptyState>}
        {program.season.map((season) => (
          <SeasonSection
            key={season.id}
            season={season}
            programID={program.id}
            onProgram={(next) => setProgram(next)}
            onEpisodeDeleted={() => {
              setNotice("Episode deleted.");
              setReload((n) => n + 1);
            }}
          />
        ))}
      </div>

      <ConfirmDialog
        open={confirmDelete}
        title="Delete this program?"
        confirmLabel="Delete program"
        danger
        busy={deleting}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => void deleteProgram()}
      >
        <p>
          <strong>{program.title}</strong> and all of its episodes will disappear from the catalog immediately. Media stays recoverable for 30 days.
        </p>
      </ConfirmDialog>
    </>
  );
}

function ProgramDetailsForm({ program, genres, onSaved }: { program: Program; genres: Genre[]; onSaved: (next: Program) => void }) {
  const api = useApi();
  const [title, setTitle] = useState(program.title);
  const [description, setDescription] = useState(program.description);
  const [genreIDs, setGenreIDs] = useState<string[]>(program.genre.map((g) => g.id));
  const [thumbnailURL, setThumbnailURL] = useState(program.thumbnailURL);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [attempted, setAttempted] = useState(false);

  useEffect(() => {
    setTitle(program.title);
    setDescription(program.description);
    setGenreIDs(program.genre.map((g) => g.id));
    setThumbnailURL(program.thumbnailURL);
  }, [program]);

  const patch = useMemo(() => {
    const body: UpdateProgramRequest = {};
    if (title !== program.title) body.title = title.trim();
    if (description !== program.description) body.description = description;
    const current = program.genre.map((g) => g.id).sort().join(",");
    if ([...genreIDs].sort().join(",") !== current) body.genreIDs = genreIDs;
    if (thumbnailURL !== program.thumbnailURL) body.thumbnailURL = thumbnailURL.trim();
    return body;
  }, [title, description, genreIDs, thumbnailURL, program]);
  const dirty = Object.keys(patch).length > 0;

  const titleError = title.trim() === "" ? "Title is required." : title.trim().length > TITLE_MAX ? `Title is limited to ${TITLE_MAX} characters.` : null;
  const genreError = genreIDs.length === 0 ? "Pick at least one genre." : null;
  const thumbError = thumbnailURL.trim() === "" ? "A thumbnail URL is required." : !isHttpURL(thumbnailURL.trim()) ? "Thumbnail must be an http(s) URL." : null;
  const invalid = titleError !== null || genreError !== null || thumbError !== null;

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setAttempted(true);
    if (!dirty || invalid) return;
    setSaving(true);
    setError(null);
    try {
      const next = await api.cms.updateProgram(program.id, patch);
      onSaved(next);
      setAttempted(false);
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="card stack" onSubmit={(e) => void onSubmit(e)} aria-labelledby="details-title" noValidate>
      <h2 id="details-title">Details</h2>
      <Field label="Title" required error={attempted ? titleError : null}>
        {(id, describedBy) => <input id={id} className="input" maxLength={TITLE_MAX} value={title} aria-describedby={describedBy} disabled={saving} onChange={(e) => setTitle(e.target.value)} />}
      </Field>
      <Field label="Description">
        {(id) => <textarea id={id} className="input" rows={4} maxLength={DESCRIPTION_MAX} value={description} disabled={saving} onChange={(e) => setDescription(e.target.value)} />}
      </Field>
      <div className={attempted && genreError ? "field field--invalid" : "field"}>
        <span className="field__label">
          Genres<span className="field__required"> *</span>
        </span>
        <GenreMultiSelect genres={genres.length > 0 ? genres : program.genre.map((g) => ({ ...g, description: "", thumbnailURL: null, programCount: 0 }))} value={genreIDs} onChange={setGenreIDs} disabled={saving} />
        {attempted && genreError && (
          <p className="field__error" role="alert">
            {genreError}
          </p>
        )}
      </div>
      <ThumbnailField required value={thumbnailURL} onChange={setThumbnailURL} error={attempted ? thumbError : null} />
      {error !== null && <ErrorBanner error={error} title="Save failed" onDismiss={() => setError(null)} />}
      <div className="row">
        <button type="submit" className="btn btn--primary" disabled={!dirty || saving}>
          {saving ? "Saving…" : "Save details"}
        </button>
        {dirty && !saving && (
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => {
              setTitle(program.title);
              setDescription(program.description);
              setGenreIDs(program.genre.map((g) => g.id));
              setThumbnailURL(program.thumbnailURL);
            }}
          >
            Discard changes
          </button>
        )}
      </div>
    </form>
  );
}

function SeasonSection({ season, programID, onProgram, onEpisodeDeleted }: { season: Season; programID: string; onProgram: (next: Program) => void; onEpisodeDeleted: () => void }) {
  return (
    <section className="card stack" aria-labelledby={`season-${season.id}`}>
      <div className="card__head">
        <h2 id={`season-${season.id}`}>
          Season {season.number}
          {season.title && <span className="muted"> — {season.title}</span>}
        </h2>
        <span className="muted">{season.episodes.length} episodes</span>
      </div>
      {season.description && <p className="muted">{season.description}</p>}
      {season.episodes.length === 0 && <EmptyState title="No episodes in this season" />}
      {season.episodes.map((episode) => (
        <EpisodeEditor key={episode.id} episode={episode} programID={programID} onProgram={onProgram} onDeleted={onEpisodeDeleted} />
      ))}
    </section>
  );
}

function anglesFromEpisode(episode: Episode): AngleDraft[] {
  return episode.streams.map((stream) => ({
    key: localKey("angle"),
    name: stream.name,
    source: "existing",
    existingUploadID: streamUploadID(stream) ?? "",
    upload: initialUploadState,
  }));
}

function EpisodeEditor({ episode, programID, onProgram, onDeleted }: { episode: Episode; programID: string; onProgram: (next: Program) => void; onDeleted: () => void }) {
  const api = useApi();
  const [title, setTitle] = useState(episode.title);
  const [description, setDescription] = useState(episode.description);
  const [publishedAt, setPublishedAt] = useState(isoToLocalInput(episode.publishedAt));
  const [thumbnailURL, setThumbnailURL] = useState(episode.thumbnailURL ?? "");
  const [replacing, setReplacing] = useState(false);
  const [angles, setAngles] = useState<AngleDraft[]>(() => anglesFromEpisode(episode));
  const [attempted, setAttempted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    setTitle(episode.title);
    setDescription(episode.description);
    setPublishedAt(isoToLocalInput(episode.publishedAt));
    setThumbnailURL(episode.thumbnailURL ?? "");
    setAngles(anglesFromEpisode(episode));
    setReplacing(false);
  }, [episode]);

  const angleIssues = useMemo(() => (replacing ? validateAngles(angles, "angles") : []), [replacing, angles]);

  const patch = useMemo(() => {
    const body: UpdateEpisodeInput = { episodeID: episode.id };
    if (title !== episode.title) body.title = title.trim();
    if (description !== episode.description) body.description = description;
    if (publishedAt !== isoToLocalInput(episode.publishedAt)) {
      const iso = localInputToISO(publishedAt);
      if (iso) body.publishedAt = iso;
    }
    if (thumbnailURL !== (episode.thumbnailURL ?? "")) body.thumbnailURL = thumbnailURL.trim() === "" ? null : thumbnailURL.trim();
    if (replacing && angleIssues.length === 0) body.streams = anglesToStreams(angles);
    return body;
  }, [episode, title, description, publishedAt, thumbnailURL, replacing, angles, angleIssues]);
  const dirty = Object.keys(patch).length > 1;

  const titleError = title.trim() === "" ? "Episode title is required." : null;
  const dateError = publishedAt !== "" && localInputToISO(publishedAt) === null ? "Enter a valid date." : null;
  const thumbError = thumbnailURL.trim() !== "" && !isHttpURL(thumbnailURL.trim()) ? "Thumbnail must be an http(s) URL." : null;
  const invalid = titleError !== null || dateError !== null || thumbError !== null || angleIssues.length > 0;

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setAttempted(true);
    if (!dirty || invalid) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const next = await api.cms.updateProgram(programID, { episodes: [patch] });
      onProgram(next);
      setSaved(true);
      setAttempted(false);
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    setDeleting(true);
    try {
      await api.cms.deleteEpisode(episode.id);
      setConfirmDelete(false);
      onDeleted();
    } catch (err) {
      setError(err);
      setConfirmDelete(false);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <form className="episode episode--editor" onSubmit={(e) => void onSubmit(e)} noValidate data-testid="episode-editor">
      <div className="card__head">
        <h3>
          Episode {episode.number}: {episode.title}
        </h3>
        <span className="muted">
          {formatDuration(episode.durationSec)} · {episode.streams.length} angle{episode.streams.length === 1 ? "" : "s"}
        </span>
      </div>
      <div className="grid grid--2">
        <Field label="Title" required error={attempted ? titleError : null}>
          {(id, describedBy) => <input id={id} className="input" maxLength={TITLE_MAX} value={title} aria-describedby={describedBy} disabled={saving} onChange={(e) => setTitle(e.target.value)} />}
        </Field>
        <Field label="Publish date" error={attempted ? dateError : null}>
          {(id, describedBy) => <input id={id} type="datetime-local" className="input" value={publishedAt} aria-describedby={describedBy} disabled={saving} onChange={(e) => setPublishedAt(e.target.value)} />}
        </Field>
      </div>
      <Field label="Description">
        {(id) => <textarea id={id} className="input" rows={2} maxLength={DESCRIPTION_MAX} value={description} disabled={saving} onChange={(e) => setDescription(e.target.value)} />}
      </Field>
      <ThumbnailField label="Episode thumbnail" value={thumbnailURL} onChange={setThumbnailURL} error={attempted ? thumbError : null} />

      <div className="angles-current">
        <div className="card__head">
          <h4>Camera angles</h4>
          {!replacing ? (
            <button type="button" className="btn btn--small" disabled={saving} onClick={() => setReplacing(true)}>
              Replace angle set
            </button>
          ) : (
            <button
              type="button"
              className="btn btn--small btn--ghost"
              disabled={saving}
              onClick={() => {
                setReplacing(false);
                setAngles(anglesFromEpisode(episode));
              }}
            >
              Keep current angles
            </button>
          )}
        </div>
        {!replacing && (
          <ol className="angle-list">
            {episode.streams.map((stream, i) => (
              <li key={`${stream.name}-${i}`}>
                <strong>{stream.name}</strong>
                {i === 0 && <span className="tag">default</span>} <code>{streamUploadID(stream) ?? "unknown upload"}</code>
              </li>
            ))}
          </ol>
        )}
        {replacing && (
          <>
            <p className="muted">Saving replaces the episode's whole angle set. Angles listed here with their current uploadID are kept; add a new ZIP or uploadID for new angles.</p>
            <AngleSetEditor context={`Episode ${episode.number}`} angles={angles} onChange={(update) => setAngles(update)} issues={attempted ? angleIssues : []} issuePrefix="angles" disabled={saving} />
          </>
        )}
      </div>

      {error !== null && <ErrorBanner error={error} title="Episode not saved" onDismiss={() => setError(null)} />}
      {saved && <SuccessBanner onDismiss={() => setSaved(false)}>Episode saved.</SuccessBanner>}
      <div className="row row--space">
        <button type="submit" className="btn btn--primary" disabled={!dirty || saving}>
          {saving ? "Saving…" : "Save episode"}
        </button>
        <button type="button" className="btn btn--danger-ghost" disabled={saving} onClick={() => setConfirmDelete(true)}>
          Delete episode
        </button>
      </div>
      <ConfirmDialog open={confirmDelete} title="Delete this episode?" confirmLabel="Delete episode" danger busy={deleting} onCancel={() => setConfirmDelete(false)} onConfirm={() => void remove()}>
        <p>
          Episode {episode.number} <strong>{episode.title}</strong> will be removed from the program. Its uploads are reclaimed after 30 days.
        </p>
      </ConfirmDialog>
    </form>
  );
}
