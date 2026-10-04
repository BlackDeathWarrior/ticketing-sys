import { describe, expect, it } from 'vitest';
import {
  checkFiles,
  errorMessage,
  formatBytes,
  issuesToErrors,
  submissionId,
  validate,
} from './logic';

const valid = {
  submissionId: '0b5c6f1e-1c1d-4a52-9d57-3f1f0e0c9a11',
  name: 'Lena Fischer',
  email: 'lena.fischer@example.org',
  subject: 'Wrong size delivered',
  description: 'I ordered a medium jacket and received a small one.',
};

describe('help center form logic', () => {
  it('formats sizes', () => {
    expect(formatBytes(900)).toBe('900 B');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(10 * 1024 * 1024)).toBe('10 MB');
    expect(formatBytes(1.5 * 1024 * 1024)).toBe('1.5 MB');
  });

  it('checks file count and size', () => {
    const mb = 1024 * 1024;
    expect(checkFiles([{ name: 'a.png', size: mb }], 3, 10 * mb)).toBeNull();
    expect(
      checkFiles(
        [
          { name: 'a', size: 1 },
          { name: 'b', size: 1 },
        ],
        1,
        mb,
      ),
    ).toBe('Attach up to 1 file.');
    expect(checkFiles([{ name: 'big.pdf', size: 11 * mb }], 3, 10 * mb)).toBe(
      'big.pdf is larger than 10 MB.',
    );
  });

  it('validates with the shared schema, field by field', () => {
    expect(validate(valid)).toEqual({});
    const errors = validate({ ...valid, email: 'nope', description: 'short' });
    expect(errors.email).toBe('Enter a valid email address');
    expect(errors.description).toBe('Describe the problem in a few words');
    expect(validate({ ...valid, categoryId: '' })).toEqual({});
  });

  it('maps API issues and messages', () => {
    expect(issuesToErrors([{ path: 'subject', message: 'Add a short subject' }])).toEqual({
      subject: 'Add a short subject',
    });
    expect(errorMessage({ message: 'Unknown topic' }, 400)).toBe('Unknown topic');
    expect(errorMessage({ message: 'Validation failed' }, 400)).toBe(
      'Please check the form and try again.',
    );
    expect(errorMessage(null, 502)).toMatch(/our side/);
  });

  it('makes v4 submission ids', () => {
    expect(submissionId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});
