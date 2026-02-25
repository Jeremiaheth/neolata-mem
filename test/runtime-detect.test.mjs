import { describe, it, expect } from 'vitest';
import { detectKeyMoments } from '../src/runtime.mjs';

describe('detectKeyMoments', () => {
  it('detects decision moment in assistant text', () => {
    const input = 'Decision: use Supabase for storage.';
    const moments = detectKeyMoments(input, { role: 'assistant' });
    expect(moments).toHaveLength(1);
    expect(moments[0].type).toBe('decision');
    expect(moments[0].importance).toBe(0.9);
    expect(moments[0].text).toContain('Supabase');
  });

  it('detects preference moment in user text', () => {
    const moments = detectKeyMoments('I prefer dark mode.', { role: 'user' });
    expect(moments).toHaveLength(1);
    expect(moments[0].type).toBe('preference');
    expect(moments[0].importance).toBe(0.7);
  });

  it('returns multiple moments from one text', () => {
    const input = [
      'We decided to use Postgres.',
      'I prefer short commit messages.',
      'TODO: add migration tests.',
      'Blocked by RLS permissions.',
    ].join(' ');
    const moments = detectKeyMoments(input);
    expect(moments).toHaveLength(4);
    expect(moments.map((m) => m.type)).toEqual(['decision', 'preference', 'commitment', 'blocker']);
  });

  it('returns empty array when no moments are present', () => {
    const moments = detectKeyMoments('The weather is clear and the build is green.');
    expect(moments).toEqual([]);
  });

  it('matches case-insensitively', () => {
    const moments = detectKeyMoments('DECISION: ship the patch now.');
    expect(moments).toHaveLength(1);
    expect(moments[0].type).toBe('decision');
  });

  it('detects commitment from TODO marker', () => {
    const moments = detectKeyMoments('TODO: fix the bug before release.');
    expect(moments).toHaveLength(1);
    expect(moments[0].type).toBe('commitment');
    expect(moments[0].importance).toBe(0.8);
  });

  it('detects blocker moments', () => {
    const moments = detectKeyMoments('Blocked by RLS permissions.');
    expect(moments).toHaveLength(1);
    expect(moments[0].type).toBe('blocker');
    expect(moments[0].importance).toBe(0.85);
  });

  it('extracts only containing sentence, not full paragraph', () => {
    const input = 'This intro sentence should not be returned. Decision: use Supabase for auth and DB. Final sentence here.';
    const moments = detectKeyMoments(input);
    expect(moments).toHaveLength(1);
    expect(moments[0].text).toBe('Decision: use Supabase for auth and DB.');
    expect(moments[0].text).not.toContain('intro sentence');
    expect(moments[0].text).not.toContain('Final sentence');
  });
});
