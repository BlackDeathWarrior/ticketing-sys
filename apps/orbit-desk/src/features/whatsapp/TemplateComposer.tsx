import { templatePreview, type WaTemplateView } from '@tms/shared';
import { useEffect, useMemo, useState } from 'react';
import { Button, Input, Select } from '../../components/ui';
import { useGet } from '../../lib/useGet';
import { templateFields, templateInput, templateLabel, templateReady } from './logic';
import styles from './WhatsApp.module.css';

interface Props {
  /** Why free text isn't possible right now. */
  reason: string;
  busy: boolean;
  /** Sends the chosen template; resolves true when it was accepted. */
  onSend: (input: ReturnType<typeof templateInput>) => Promise<boolean>;
}

/**
 * The reply box for a WhatsApp conversation outside the 24-hour window: pick
 * an approved template, fill in its variables, and see what the customer gets.
 */
export function TemplateComposer({ reason, busy, onSend }: Props) {
  const templates = useGet<WaTemplateView[]>('/whatsapp/templates');
  const [templateId, setTemplateId] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const list = useMemo(() => templates.data ?? [], [templates.data]);
  const template = list.find((t) => t.id === templateId) ?? null;

  useEffect(() => {
    if (!templateId && list[0]) setTemplateId(list[0].id);
  }, [list, templateId]);

  const fields = template ? templateFields(template) : [];
  const input = template ? templateInput(template, values) : null;

  const send = async () => {
    if (!template || !input) return;
    if (await onSend(input)) setValues({});
  };

  return (
    <div className={styles.composer} role="group" aria-label="WhatsApp template">
      <p className={styles.note}>{reason}</p>
      {templates.error && (
        <p className={styles.note} role="alert">
          {templates.error}
        </p>
      )}
      {templates.data && list.length === 0 ? (
        <p className={styles.empty}>
          No approved templates yet. An admin can sync them from Meta in Settings → Channels.
        </p>
      ) : (
        template && (
          <>
            <Select
              id="wa-template"
              label="Template"
              value={templateId}
              onChange={(e) => {
                setTemplateId(e.target.value);
                setValues({});
              }}
              options={list.map((t) => ({ value: t.id, label: templateLabel(t) }))}
            />
            {fields.length > 0 && (
              <div className={styles.fields}>
                {fields.map((f) => (
                  <Input
                    key={f.key}
                    id={`wa-field-${f.key.replace(/\W/g, '-')}`}
                    label={f.label}
                    type={f.kind === 'url' ? 'url' : 'text'}
                    value={values[f.key] ?? ''}
                    required={!f.optional}
                    onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
                  />
                ))}
              </div>
            )}
            <div className={styles.preview} aria-label="What the customer will read">
              {templatePreview(template, {
                body: (input?.body ?? []).map((v, i) => v || `{{${i + 1}}}`),
                headerText: input?.headerText,
              })}
            </div>
          </>
        )
      )}
      <div className={styles.foot}>
        <Button
          variant="secondary"
          icon="send"
          disabled={!template || busy || !templateReady(template, values)}
          onClick={() => void send()}
        >
          Send template
        </Button>
      </div>
    </div>
  );
}
