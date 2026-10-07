import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useApi } from "../api/ApiContext";
import type { Genre, ProgramSummary, SearchProgramResult } from "../api/types";
import { EmptyState } from "../components/EmptyState";
import { ErrorBanner } from "../components/ErrorBanner";
import { Loading } from "../components/Loading";
import { formatDateTime } from "../lib/format";

const PAGE_SIZE = 12;

export function DashboardPage() {
  const api = useApi();
  const [genres, setGenres] = useState<Genre[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [query, setQuery] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    setGenres(null);
    setError(null);
    api.catalog
      .listGenres(controller.signal)
      .then((res) => setGenres(res.genres))
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setError(err);
      });
    return () => controller.abort();
  }, [api, reloadToken]);

  const trimmed = query.trim();

  return (
    <>
      <div className="page__head">
        <div>
          <h1>Catalog</h1>
          <p className="muted">Programs grouped by genre. Open a program to edit it, or search across the catalog.</p>
        </div>
        <Link to="/programs/new" className="btn btn--primary">
          New program
        </Link>
      </div>
      <div className="searchbar">
        <input
          type="search"
          className="input"
          placeholder="Search programs and episodes…"
          aria-label="Search programs and episodes"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      {trimmed !== "" ? (
        <SearchResults query={trimmed} />
      ) : (
        <>
          {error !== null && <ErrorBanner error={error} title="Could not load genres" onRetry={() => setReloadToken((n) => n + 1)} />}
          {genres === null && error === null && <Loading label="Loading genres…" />}
          {genres !== null && genres.length === 0 && (
            <EmptyState title="No genres yet">Genres are seeded on the server. Once one exists, its programs appear here.</EmptyState>
          )}
          {genres?.map((genre) => <GenreSection key={genre.id} genre={genre} />)}
        </>
      )}
    </>
  );
}

function GenreSection({ genre }: { genre: Genre }) {
  const api = useApi();
  const [programs, setPrograms] = useState<ProgramSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(
    async (next: string | null, append: boolean) => {
      setLoading(true);
      setError(null);
      try {
        const res = await api.catalog.listProgramsByGenre(genre.id, { limit: PAGE_SIZE, cursor: next });
        setPrograms((prev) => (append ? [...prev, ...res.programs] : res.programs));
        setCursor(res.nextCursor);
        setTotal(res.total);
      } catch (err) {
        setError(err);
      } finally {
        setLoading(false);
      }
    },
    [api, genre.id],
  );

  useEffect(() => {
    void load(null, false);
  }, [load]);

  return (
    <section className="genre" aria-labelledby={`genre-${genre.id}`}>
      <div className="genre__head">
        <h2 id={`genre-${genre.id}`}>{genre.name}</h2>
        <span className="muted">{total === null ? `${genre.programCount} programs` : `${total} programs`}</span>
      </div>
      {genre.description && <p className="muted genre__desc">{genre.description}</p>}
      {error !== null && <ErrorBanner error={error} title="Could not load programs" onRetry={() => void load(null, false)} />}
      {programs.length === 0 && !loading && error === null && (
        <EmptyState title="No programs in this genre">
          <Link to="/programs/new">Create one</Link> and assign it to {genre.name}.
        </EmptyState>
      )}
      <ul className="cards">
        {programs.map((program) => (
          <ProgramCard key={program.id} program={program} />
        ))}
      </ul>
      {loading && <Loading label="Loading programs…" />}
      {cursor && !loading && (
        <button type="button" className="btn" onClick={() => void load(cursor, true)}>
          Load more
        </button>
      )}
    </section>
  );
}

function ProgramCard({ program }: { program: ProgramSummary | SearchProgramResult }) {
  return (
    <li className="card program-card">
      <Link to={`/programs/${program.id}`} className="program-card__link">
        <div className="program-card__thumb">
          {program.thumbnailURL ? <img src={program.thumbnailURL} alt="" loading="lazy" /> : <span className="program-card__noimg" />}
        </div>
        <div className="program-card__body">
          <h3 className="program-card__title">{program.title}</h3>
          <p className="program-card__desc">{program.description}</p>
          <p className="program-card__meta">
            {program.genre.map((g) => g.name).join(", ")}
            {"updatedAt" in program && <> · updated {formatDateTime(program.updatedAt)}</>}
            {"matchedBy" in program && <> · matched by {program.matchedBy}</>}
          </p>
        </div>
      </Link>
    </li>
  );
}

function SearchResults({ query }: { query: string }) {
  const api = useApi();
  const [results, setResults] = useState<SearchProgramResult[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setError(null);
      api.catalog
        .search(query, { limit: 50 }, controller.signal)
        .then((res) => {
          setResults(res.programs);
          setTotal(res.total);
        })
        .catch((err: unknown) => {
          if (!controller.signal.aborted) setError(err);
        });
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [api, query]);

  return (
    <section aria-live="polite">
      <div className="genre__head">
        <h2>Search results</h2>
        {results && <span className="muted">{total} matches</span>}
      </div>
      {error !== null && <ErrorBanner error={error} title="Search failed" />}
      {results === null && error === null && <Loading label="Searching…" />}
      {results?.length === 0 && <EmptyState title={`Nothing matches “${query}”`} />}
      <ul className="cards">{results?.map((program) => <ProgramCard key={program.id} program={program} />)}</ul>
    </section>
  );
}
