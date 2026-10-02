import { describe, expect, it } from 'vitest';
import { litellmErrorReason } from './litellm-error';

describe('litellmErrorReason', () => {
  it("gives the provider's own message when the error carries its JSON body", () => {
    const error = [
      'litellm.NotFoundError: GeminiException - {',
      '  "error": {',
      '    "code": 404,',
      '    "message": "This model models/old-flash is no longer available to new users. Use \\"new-flash\\".",',
      '    "status": "NOT_FOUND"',
      '  }',
      '}',
      'stack trace: Traceback (most recent call last):',
      '  File "/app/main.py", line 1, in <module>',
    ].join('\n');
    expect(litellmErrorReason(error)).toBe(
      'This model models/old-flash is no longer available to new users. Use "new-flash".',
    );
  });

  it('reads a body that is on one line', () => {
    expect(
      litellmErrorReason(
        'litellm.AuthenticationError: AnthropicException - {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
      ),
    ).toBe('invalid x-api-key');
  });

  it('falls back to the first line, without the exception class', () => {
    expect(litellmErrorReason('litellm.Timeout: Timeout exceeded\nTraceback (most recent…')).toBe(
      'Timeout exceeded',
    );
    expect(litellmErrorReason('Connection refused')).toBe('Connection refused');
  });

  it('never passes a key on, and stays short', () => {
    const leaked = litellmErrorReason(
      'litellm.APIError: GET https://provider.example/v1/models?key=abc123-SECRET&x=1 failed',
    )!;
    expect(leaked).not.toContain('abc123');
    expect(leaked).toContain('key=…');
    expect(litellmErrorReason(`{"message": "${'x'.repeat(900)}"}`)).toHaveLength(300);
  });

  it('has nothing to say about nothing', () => {
    expect(litellmErrorReason(undefined)).toBeUndefined();
    expect(litellmErrorReason('  \n')).toBeUndefined();
  });
});
