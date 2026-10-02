const MAX = 300;

/**
 * What went wrong, from an error LiteLLM reports. Providers answer with a JSON
 * body that LiteLLM passes on spread over several lines, followed by a Python
 * traceback: the provider's own `message` is the useful part. Without one, the
 * first line is.
 */
export function litellmErrorReason(text: string | undefined): string | undefined {
  if (!text?.trim()) return undefined;
  const quoted = /"message"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(text)?.[1];
  let reason: string | undefined;
  if (quoted) {
    try {
      reason = String(JSON.parse(quoted));
    } catch {
      reason = undefined;
    }
  }
  reason ??= text
    .trim()
    .split('\n')[0]!
    .replace(/^litellm\.\w+:\s*/, '');
  // A provider's address can carry the key; it must not reach the settings page or the audit log.
  return (
    reason
      .replace(/\b(key|api_key|token)=[^\s&"']+/gi, '$1=…')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX) || undefined
  );
}
