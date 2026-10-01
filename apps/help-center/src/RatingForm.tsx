import { CSAT_LABELS, type CsatView } from '@tms/shared';
import { type FormEvent, useId, useState } from 'react';

interface Props {
  /** The rating given earlier, if any: the form then changes it. */
  current: CsatView | null;
  /** Sends the rating; throws with a message for the customer when it can't be saved. */
  onSubmit: (rating: number, comment: string) => Promise<CsatView>;
}

/** "How did we do?": five choices and an optional comment. */
export function RatingForm({ current, onSubmit }: Props) {
  const uid = useId();
  const [saved, setSaved] = useState<CsatView | null>(current);
  const [rating, setRating] = useState<number | null>(current?.rating ?? null);
  const [comment, setComment] = useState(current?.comment ?? '');
  const [editing, setEditing] = useState(!current);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (rating === null) {
      setError('Choose a rating first.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setSaved(await onSubmit(rating, comment));
      setEditing(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (saved && !editing) {
    return (
      <div className="rating-done" role="status">
        <p>
          <strong>Thanks for your rating.</strong> You rated this request {saved.rating} out of 5 (
          {CSAT_LABELS[saved.rating]}).
        </p>
        {saved.comment && <p className="muted">“{saved.comment}”</p>}
        <button type="button" className="link-button" onClick={() => setEditing(true)}>
          Change my rating
        </button>
      </div>
    );
  }

  return (
    <form className="form" onSubmit={submit} aria-label="Rate this request">
      <fieldset className="rating">
        <legend>How did we do?</legend>
        <div className="rating__options">
          {[1, 2, 3, 4, 5].map((n) => (
            <label key={n} className="rating__option">
              <input
                type="radio"
                name={`${uid}-rating`}
                value={n}
                checked={rating === n}
                onChange={() => {
                  setRating(n);
                  setError(null);
                }}
              />
              <span className="rating__number">{n}</span>
              <span className="rating__label">{CSAT_LABELS[n]}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <div className="field">
        <label htmlFor={`${uid}-comment`}>Anything you'd like to add? (optional)</label>
        <textarea
          id={`${uid}-comment`}
          rows={3}
          maxLength={2000}
          value={comment}
          onChange={(e) => setComment(e.target.value)}
        />
      </div>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      <div className="actions">
        <button type="submit" className="button button--primary" disabled={busy}>
          {busy ? 'Sending…' : saved ? 'Update rating' : 'Send rating'}
        </button>
      </div>
    </form>
  );
}
