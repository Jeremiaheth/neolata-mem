import { describe, it, expect } from 'vitest';
import { createMemory } from '../src/index.mjs';
import { createMockSupabase } from './mock-supabase.mjs';

describe('createMemory() with supabase storage', () => {
  it('creates a working graph via factory', async () => {
    const mock = createMockSupabase();
    const mem = createMemory({
      storage: {
        type: 'supabase',
        url: 'https://test.supabase.co',
        key: 'test-key',
        fetch: mock.fetch,
      },
    });

    const result = await mem.store('agent-1', 'Factory test fact');
    expect(result.id).toMatch(/^[0-9a-f]{8}-/);

    const results = await mem.search('agent-1', 'Factory test');
    expect(results.length).toBe(1);
    expect(results[0].memory).toBe('Factory test fact');
  });

  it('throws if url is missing', () => {
    expect(() => createMemory({
      storage: { type: 'supabase', key: 'k' },
    })).toThrow('url is required');
  });

  it('throws if key is missing', () => {
    expect(() => createMemory({
      storage: { type: 'supabase', url: 'https://x.supabase.co' },
    })).toThrow('key is required');
  });
});
