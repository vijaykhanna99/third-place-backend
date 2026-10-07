import type { Genre } from "../api/types";

interface Props {
  genres: Genre[];
  value: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
}

export function GenreMultiSelect({ genres, value, onChange, disabled = false }: Props) {
  const toggle = (id: string) => {
    onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id]);
  };
  if (genres.length === 0) return <p className="muted">No genres exist yet. Genres are seeded server-side.</p>;
  return (
    <div className="chips" role="group" aria-label="Genres">
      {genres.map((genre) => {
        const checked = value.includes(genre.id);
        return (
          <label key={genre.id} className={checked ? "chip chip--on" : "chip"}>
            <input type="checkbox" checked={checked} disabled={disabled} onChange={() => toggle(genre.id)} />
            {genre.name}
          </label>
        );
      })}
    </div>
  );
}
