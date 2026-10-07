import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useApi } from "../api/ApiContext";
import type { Genre } from "../api/types";
import { AngleSetEditor } from "../components/AngleSetEditor";
import { ErrorBanner } from "../components/ErrorBanner";
import { Field } from "../components/Field";
import { GenreMultiSelect } from "../components/GenreMultiSelect";
import { Loading } from "../components/Loading";
import { ThumbnailField } from "../components/ThumbnailField";
import {
  DESCRIPTION_MAX,
  TITLE_MAX,
  allAnglesReady,
  angleUploadID,
  emptyDraft,
  issuesFor,
  newEpisode,
  newSeason,
  toCreateProgramRequest,
  validateDraft,
  type AngleDraft,
  type DraftIssue,
  type EpisodeDraft,
  type ProgramDraft,
  type SeasonDraft,
} from "../programs/draft";
import { isUploadActive } from "../upload/uploadMachine";

type Step = 0 | 1 | 2;
const STEPS = ["Details", "Seasons & episodes", "Review"] as const;

const DETAIL_PATHS = new Set(["title", "description", "genreIDs", "thumbnailURL"]);

function stepIssues(step: Step, issues: DraftIssue[]): DraftIssue[] {
  if (step === 0) return issues.filter((i) => DETAIL_PATHS.has(i.path));
  if (step === 1) return issues.filter((i) => i.path.startsWith("seasons"));
  return issues;
}

export function NewProgramPage() {
  const api = useApi();
  const navigate = useNavigate();
  const [draft, setDraft] = useState<ProgramDraft>(emptyDraft);
  const [step, setStep] = useState<Step>(0);
  const [attempted, setAttempted] = useState<Record<number, boolean>>({});
  const [genres, setGenres] = useState<Genre[] | null>(null);
  const [genresError, setGenresError] = useState<unknown>(null);
  const [genresReload, setGenresReload] = useState(0);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<unknown>(null);

  useEffect(() => {
    const controller = new AbortController();
    setGenresError(null);
    api.catalog
      .listGenres(controller.signal)
      .then((res) => setGenres(res.genres))
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setGenresError(err);
      });
    return () => controller.abort();
  }, [api, genresReload]);

  const issues = useMemo(() => validateDraft(draft), [draft]);
  const uploadsActive = draft.seasons.some((s) => s.episodes.some((e) => e.angles.some((a) => a.source === "zip" && isUploadActive(a.upload))));

  useEffect(() => {
    if (!uploadsActive) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [uploadsActive]);

  const visibleIssues = attempted[step] ? stepIssues(step, issues) : [];

  const goNext = () => {
    setAttempted((prev) => ({ ...prev, [step]: true }));
    if (stepIssues(step, issues).length > 0) return;
    setStep((s) => (s < 2 ? ((s + 1) as Step) : s));
  };

  const updateSeason = (seasonKey: string, patch: Partial<SeasonDraft>) =>
    setDraft((prev) => ({ ...prev, seasons: prev.seasons.map((s) => (s.key === seasonKey ? { ...s, ...patch } : s)) }));

  const updateEpisode = (seasonKey: string, episodeKey: string, patch: Partial<EpisodeDraft>) =>
    setDraft((prev) => ({
      ...prev,
      seasons: prev.seasons.map((s) =>
        s.key === seasonKey ? { ...s, episodes: s.episodes.map((e) => (e.key === episodeKey ? { ...e, ...patch } : e)) } : s,
      ),
    }));

  const updateAngles = (seasonKey: string, episodeKey: string, update: (prev: AngleDraft[]) => AngleDraft[]) =>
    setDraft((prev) => ({
      ...prev,
      seasons: prev.seasons.map((s) =>
        s.key === seasonKey
          ? { ...s, episodes: s.episodes.map((e) => (e.key === episodeKey ? { ...e, angles: update(e.angles) } : e)) }
          : s,
      ),
    }));

  const create = async () => {
    setAttempted({ 0: true, 1: true, 2: true });
    if (issues.length > 0) return;
    setCreating(true);
    setCreateError(null);
    try {
      const program = await api.cms.createProgram(toCreateProgramRequest(draft));
      navigate(`/programs/${program.id}`, { replace: true, state: { created: true } });
    } catch (err) {
      setCreateError(err);
      setCreating(false);
    }
  };

  const canCreate = issues.length === 0 && allAnglesReady(draft) && !creating;

  return (
    <>
      <div className="page__head">
        <div>
          <h1>New program</h1>
          <p className="muted">Describe the program, lay out its seasons and episodes, and attach one HLS archive per camera angle.</p>
        </div>
        <Link to="/" className="btn">
          Cancel
        </Link>
      </div>

      <ol className="steps" aria-label="Progress">
        {STEPS.map((label, i) => (
          <li key={label} className={i === step ? "steps__item steps__item--current" : i < step ? "steps__item steps__item--done" : "steps__item"} aria-current={i === step ? "step" : undefined}>
            <button type="button" className="steps__button" onClick={() => setStep(i as Step)} disabled={i > step && stepIssues(step, issues).length > 0}>
              <span className="steps__num">{i + 1}</span> {label}
            </button>
          </li>
        ))}
      </ol>

      {step === 0 && (
        <section className="card stack" aria-labelledby="step-details">
          <h2 id="step-details">Program details</h2>
          <Field label="Title" required error={issuesFor(visibleIssues, "title")} hint={`${draft.title.length}/${TITLE_MAX}`}>
            {(id, describedBy) => (
              <input id={id} className="input" maxLength={TITLE_MAX} value={draft.title} aria-describedby={describedBy} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
            )}
          </Field>
          <Field label="Description" error={issuesFor(visibleIssues, "description")} hint={`${draft.description.length}/${DESCRIPTION_MAX}`}>
            {(id, describedBy) => (
              <textarea id={id} className="input" rows={4} maxLength={DESCRIPTION_MAX} value={draft.description} aria-describedby={describedBy} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
            )}
          </Field>
          <div className={issuesFor(visibleIssues, "genreIDs") ? "field field--invalid" : "field"}>
            <span className="field__label">
              Genres<span className="field__required"> *</span>
            </span>
            {genresError !== null && <ErrorBanner error={genresError} title="Could not load genres" onRetry={() => setGenresReload((n) => n + 1)} />}
            {genres === null && genresError === null && <Loading label="Loading genres…" />}
            {genres && <GenreMultiSelect genres={genres} value={draft.genreIDs} onChange={(genreIDs) => setDraft({ ...draft, genreIDs })} />}
            {issuesFor(visibleIssues, "genreIDs") && (
              <p className="field__error" role="alert">
                {issuesFor(visibleIssues, "genreIDs")}
              </p>
            )}
          </div>
          <ThumbnailField required value={draft.thumbnailURL} onChange={(thumbnailURL) => setDraft({ ...draft, thumbnailURL })} error={issuesFor(visibleIssues, "thumbnailURL")} />
        </section>
      )}

      {step === 1 && (
        <section className="stack" aria-labelledby="step-structure">
          <h2 id="step-structure" className="visually-hidden">
            Seasons and episodes
          </h2>
          {draft.seasons.map((season, si) => {
            const sp = `seasons.${si}`;
            return (
              <section key={season.key} className="card stack season" data-testid="season">
                <div className="card__head">
                  <h3>Season {season.number}</h3>
                  <button
                    type="button"
                    className="btn btn--small btn--danger-ghost"
                    disabled={draft.seasons.length === 1}
                    onClick={() => setDraft((prev) => ({ ...prev, seasons: prev.seasons.filter((s) => s.key !== season.key) }))}
                  >
                    Remove season
                  </button>
                </div>
                <div className="grid grid--3">
                  <Field label="Season number" required error={issuesFor(visibleIssues, `${sp}.number`)}>
                    {(id, describedBy) => (
                      <input id={id} type="number" min={1} className="input" value={season.number} aria-describedby={describedBy} onChange={(e) => updateSeason(season.key, { number: Number(e.target.value) })} />
                    )}
                  </Field>
                  <Field label="Season title" error={issuesFor(visibleIssues, `${sp}.title`)}>
                    {(id, describedBy) => <input id={id} className="input" maxLength={TITLE_MAX} value={season.title} aria-describedby={describedBy} onChange={(e) => updateSeason(season.key, { title: e.target.value })} />}
                  </Field>
                  <Field label="Season description">
                    {(id) => <input id={id} className="input" maxLength={DESCRIPTION_MAX} value={season.description} onChange={(e) => updateSeason(season.key, { description: e.target.value })} />}
                  </Field>
                </div>
                {issuesFor(visibleIssues, `${sp}.episodes`) && <p className="field__error">{issuesFor(visibleIssues, `${sp}.episodes`)}</p>}
                {season.episodes.map((episode, ei) => {
                  const ep = `${sp}.episodes.${ei}`;
                  return (
                    <fieldset key={episode.key} className="episode" data-testid="episode">
                      <legend className="episode__legend">
                        Episode {episode.number}
                        <button
                          type="button"
                          className="btn btn--small btn--danger-ghost"
                          disabled={season.episodes.length === 1}
                          onClick={() => updateSeason(season.key, { episodes: season.episodes.filter((e) => e.key !== episode.key) })}
                        >
                          Remove episode
                        </button>
                      </legend>
                      <div className="grid grid--3">
                        <Field label="Episode number" required error={issuesFor(visibleIssues, `${ep}.number`)}>
                          {(id, describedBy) => (
                            <input id={id} type="number" min={1} className="input" value={episode.number} aria-describedby={describedBy} onChange={(e) => updateEpisode(season.key, episode.key, { number: Number(e.target.value) })} />
                          )}
                        </Field>
                        <Field label="Episode title" required error={issuesFor(visibleIssues, `${ep}.title`)}>
                          {(id, describedBy) => (
                            <input id={id} className="input" maxLength={TITLE_MAX} value={episode.title} aria-describedby={describedBy} onChange={(e) => updateEpisode(season.key, episode.key, { title: e.target.value })} />
                          )}
                        </Field>
                        <Field label="Publish date" required error={issuesFor(visibleIssues, `${ep}.publishedAt`)}>
                          {(id, describedBy) => (
                            <input id={id} type="datetime-local" className="input" value={episode.publishedAt} aria-describedby={describedBy} onChange={(e) => updateEpisode(season.key, episode.key, { publishedAt: e.target.value })} />
                          )}
                        </Field>
                      </div>
                      <Field label="Episode description" error={issuesFor(visibleIssues, `${ep}.description`)}>
                        {(id, describedBy) => (
                          <textarea id={id} className="input" rows={2} maxLength={DESCRIPTION_MAX} value={episode.description} aria-describedby={describedBy} onChange={(e) => updateEpisode(season.key, episode.key, { description: e.target.value })} />
                        )}
                      </Field>
                      <ThumbnailField
                        label="Episode thumbnail (optional)"
                        value={episode.thumbnailURL}
                        onChange={(thumbnailURL) => updateEpisode(season.key, episode.key, { thumbnailURL })}
                        error={issuesFor(visibleIssues, `${ep}.thumbnailURL`)}
                      />
                      <h4 className="episode__angles-title">Camera angles</h4>
                      <AngleSetEditor
                        context={`Season ${season.number} episode ${episode.number}`}
                        angles={episode.angles}
                        issues={visibleIssues}
                        issuePrefix={`${ep}.angles`}
                        onChange={(update) => updateAngles(season.key, episode.key, update)}
                      />
                    </fieldset>
                  );
                })}
                <div>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => updateSeason(season.key, { episodes: [...season.episodes, newEpisode(Math.max(0, ...season.episodes.map((e) => e.number)) + 1)] })}
                  >
                    Add episode
                  </button>
                </div>
              </section>
            );
          })}
          <div>
            <button type="button" className="btn" onClick={() => setDraft((prev) => ({ ...prev, seasons: [...prev.seasons, newSeason(Math.max(0, ...prev.seasons.map((s) => s.number)) + 1)] }))}>
              Add season
            </button>
          </div>
        </section>
      )}

      {step === 2 && (
        <section className="card stack" aria-labelledby="step-review">
          <h2 id="step-review">Review</h2>
          <dl className="kv">
            <dt>Title</dt>
            <dd>{draft.title || <em className="muted">missing</em>}</dd>
            <dt>Genres</dt>
            <dd>{draft.genreIDs.map((id) => genres?.find((g) => g.id === id)?.name ?? id).join(", ") || <em className="muted">none</em>}</dd>
            <dt>Thumbnail</dt>
            <dd className="truncate">{draft.thumbnailURL || <em className="muted">missing</em>}</dd>
          </dl>
          {draft.seasons.map((season) => (
            <div key={season.key} className="review-season">
              <h3>
                Season {season.number}
                {season.title && <> — {season.title}</>}
              </h3>
              <ul className="review-list">
                {season.episodes.map((episode) => (
                  <li key={episode.key}>
                    <strong>
                      E{episode.number} {episode.title || <em className="muted">untitled</em>}
                    </strong>
                    <ul className="review-angles">
                      {episode.angles.map((angle, i) => {
                        const id = angleUploadID(angle);
                        return (
                          <li key={angle.key} className={id ? "review-angle review-angle--ok" : "review-angle review-angle--pending"}>
                            {angle.name || `Angle ${i + 1}`}
                            {i === 0 && <span className="tag">default</span>} — {id ? <code>{id}</code> : <span>{angle.source === "zip" ? `upload ${angle.upload.phase}` : "uploadID missing"}</span>}
                          </li>
                        );
                      })}
                    </ul>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          {issues.length > 0 && (
            <div className="banner banner--warn" role="status">
              <div className="banner__body">
                <strong>Not ready to create yet</strong>
                <ul className="issue-list">
                  {issues.slice(0, 8).map((issue) => (
                    <li key={issue.path + issue.message}>{issue.message}</li>
                  ))}
                  {issues.length > 8 && <li>…and {issues.length - 8} more</li>}
                </ul>
              </div>
            </div>
          )}
          {createError !== null && <ErrorBanner error={createError} title="Create failed" onDismiss={() => setCreateError(null)} />}
        </section>
      )}

      <div className="wizard-nav">
        <button type="button" className="btn" disabled={step === 0 || creating} onClick={() => setStep((s) => (s > 0 ? ((s - 1) as Step) : s))}>
          Back
        </button>
        {step < 2 ? (
          <button type="button" className="btn btn--primary" onClick={goNext}>
            Next
          </button>
        ) : (
          <button type="button" className="btn btn--primary" disabled={!canCreate} onClick={() => void create()} title={canCreate ? undefined : "Every angle must be ready before the program can be created"}>
            {creating ? "Creating…" : "Create program"}
          </button>
        )}
      </div>
      {step === 1 && stepIssues(1, issues).length > 0 && attempted[1] && (
        <p className="muted">Fix the highlighted fields to continue. Uploads can keep running while you edit other episodes.</p>
      )}
    </>
  );
}
