import {
  WEB_FORM_MAX_FILE_BYTES,
  WEB_FORM_MAX_FILES,
  type WebFormConfig,
  type WebFormReceipt,
} from '@tms/shared';
import { type FormEvent, useId, useRef, useState } from 'react';
import {
  checkFiles,
  errorMessage,
  type FieldErrors,
  formatBytes,
  issuesToErrors,
  submissionId,
  validate,
} from './logic';

interface Props {
  config: WebFormConfig | null;
  onSubmitted: (receipt: WebFormReceipt) => void;
}

const DESCRIPTION_MAX = 10_000;

export function RequestForm({ config, onSubmitted }: Props) {
  const maxFiles = config?.maxFiles ?? WEB_FORM_MAX_FILES;
  const maxBytes = config?.maxFileBytes ?? WEB_FORM_MAX_FILE_BYTES;
  // One id per form: a double click or a retry after a network error can't open two tickets.
  const [formId, setFormId] = useState(submissionId);
  const [values, setValues] = useState({
    name: '',
    email: '',
    categoryId: '',
    subject: '',
    orderNumber: '',
    description: '',
    website: '',
  });
  const [files, setFiles] = useState<File[]>([]);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const summary = useRef<HTMLDivElement>(null);
  const uid = useId();

  const set = (field: keyof typeof values) => (value: string) => {
    setValues((v) => ({ ...v, [field]: value }));
    if (errors[field as keyof FieldErrors]) setErrors((e) => ({ ...e, [field]: undefined }));
  };

  const addFiles = (list: FileList | null) => {
    if (!list?.length) return;
    const next = [...files, ...Array.from(list)];
    setErrors((e) => ({ ...e, files: checkFiles(next, maxFiles, maxBytes) ?? undefined }));
    setFiles(next);
    if (fileInput.current) fileInput.current.value = '';
  };

  const removeFile = (index: number) => {
    const next = files.filter((_, i) => i !== index);
    setErrors((e) => ({ ...e, files: checkFiles(next, maxFiles, maxBytes) ?? undefined }));
    setFiles(next);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const input = { ...values, submissionId: formId };
    const found: FieldErrors = { ...validate(input) };
    const fileProblem = checkFiles(files, maxFiles, maxBytes);
    if (fileProblem) found.files = fileProblem;
    setErrors(found);
    if (Object.values(found).some(Boolean)) {
      setFormError('Please correct the highlighted fields.');
      summary.current?.focus();
      return;
    }

    setBusy(true);
    setFormError(null);
    try {
      const body = new FormData();
      for (const [k, v] of Object.entries(input)) body.append(k, v);
      for (const f of files) body.append('files', f, f.name);
      const res = await fetch('/api/v1/public/requests', { method: 'POST', body });
      const json = (await res.json().catch(() => null)) as unknown;
      if (!res.ok) {
        const issues = (json as { issues?: Array<{ path: string; message: string }> } | null)
          ?.issues;
        if (issues) setErrors(issuesToErrors(issues));
        setFormError(errorMessage(json, res.status));
        summary.current?.focus();
        return;
      }
      onSubmitted(json as WebFormReceipt);
      setFormId(submissionId());
    } catch {
      setFormError('We could not reach the server. Check your connection and try again.');
      summary.current?.focus();
    } finally {
      setBusy(false);
    }
  };

  const field = (name: keyof FieldErrors) => ({
    id: `${uid}-${name}`,
    'aria-invalid': errors[name] ? true : undefined,
    'aria-describedby': errors[name] ? `${uid}-${name}-error` : undefined,
  });
  const error = (name: keyof FieldErrors) =>
    errors[name] ? (
      <p className="field-error" id={`${uid}-${name}-error`}>
        {errors[name]}
      </p>
    ) : null;

  return (
    <form className="form" onSubmit={submit} noValidate aria-label="Submit a request">
      <div ref={summary} tabIndex={-1} className="form-summary" aria-live="assertive">
        {formError && (
          <p className="notice" role="alert">
            {formError}
          </p>
        )}
      </div>

      <div className="row">
        <div className="field">
          <label htmlFor={`${uid}-name`}>
            Your name <span aria-hidden="true">*</span>
          </label>
          <input
            {...field('name')}
            autoComplete="name"
            required
            value={values.name}
            onChange={(e) => set('name')(e.target.value)}
          />
          {error('name')}
        </div>
        <div className="field">
          <label htmlFor={`${uid}-email`}>
            Email <span aria-hidden="true">*</span>
          </label>
          <input
            {...field('email')}
            type="email"
            autoComplete="email"
            required
            value={values.email}
            onChange={(e) => set('email')(e.target.value)}
          />
          {error('email')}
        </div>
      </div>

      <div className="row">
        {!!config?.categories.length && (
          <div className="field">
            <label htmlFor={`${uid}-topic`}>Topic</label>
            <select
              id={`${uid}-topic`}
              value={values.categoryId}
              onChange={(e) => set('categoryId')(e.target.value)}
            >
              <option value="">Not sure / other</option>
              {config.categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="field">
          <label htmlFor={`${uid}-orderNumber`}>Order number</label>
          <input
            {...field('orderNumber')}
            inputMode="text"
            placeholder="Optional"
            value={values.orderNumber}
            onChange={(e) => set('orderNumber')(e.target.value)}
          />
          {error('orderNumber')}
        </div>
      </div>

      <div className="field">
        <label htmlFor={`${uid}-subject`}>
          Subject <span aria-hidden="true">*</span>
        </label>
        <input
          {...field('subject')}
          required
          maxLength={200}
          value={values.subject}
          onChange={(e) => set('subject')(e.target.value)}
        />
        {error('subject')}
      </div>

      <div className="field">
        <label htmlFor={`${uid}-description`}>
          How can we help? <span aria-hidden="true">*</span>
        </label>
        <textarea
          {...field('description')}
          required
          rows={7}
          maxLength={DESCRIPTION_MAX}
          value={values.description}
          onChange={(e) => set('description')(e.target.value)}
        />
        <p className="hint" id={`${uid}-description-count`}>
          {values.description.length.toLocaleString()} / {DESCRIPTION_MAX.toLocaleString()}
        </p>
        {error('description')}
      </div>

      <div className="field">
        <span className="label" id={`${uid}-files-label`}>
          Attachments
        </span>
        <p className="hint">
          Up to {maxFiles} files, {formatBytes(maxBytes)} each.
        </p>
        {files.length > 0 && (
          <ul className="files" aria-labelledby={`${uid}-files-label`}>
            {files.map((f, i) => (
              <li key={`${f.name}-${i}`}>
                <span className="files__name">{f.name}</span>
                <span className="files__size">{formatBytes(f.size)}</span>
                <button
                  type="button"
                  className="link-button"
                  onClick={() => removeFile(i)}
                  aria-label={`Remove ${f.name}`}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
        <label className="button button--secondary file-button">
          Add files
          <input
            ref={fileInput}
            className="sr-only"
            type="file"
            multiple
            aria-describedby={errors.files ? `${uid}-files-error` : undefined}
            onChange={(e) => addFiles(e.target.files)}
          />
        </label>
        {error('files')}
      </div>

      {/* Honeypot: invisible to people and assistive tech, filled in only by bots. */}
      <div className="hp" aria-hidden="true">
        <label htmlFor={`${uid}-website`}>Website</label>
        <input
          id={`${uid}-website`}
          tabIndex={-1}
          autoComplete="off"
          value={values.website}
          onChange={(e) => set('website')(e.target.value)}
        />
      </div>

      <div className="actions">
        <button type="submit" className="button button--primary" disabled={busy}>
          {busy ? 'Sending…' : 'Send request'}
        </button>
      </div>
    </form>
  );
}
