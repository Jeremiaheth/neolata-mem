You are working on the neolata-mem project, a graph-native memory engine for AI agents.

## Project Structure
- src/graph.mjs — MemoryGraph class (core engine)
- src/storage.mjs — jsonStorage(), memoryStorage()
- src/embeddings.mjs — openaiEmbeddings(), noopEmbeddings(), cosineSimilarity()
- test/graph.test.mjs — Core tests using vitest, memoryStorage(), fakeEmbeddings()
- All tests run with: `npx vitest run`

## Current Link Format
In graph.mjs, the `store()` method creates links like:
```js
topLinks.map(l => ({ id: l.id, similarity: l.similarity }))
```
And backlinks:
```js
target.links.push({ id, similarity: link.similarity });
```

## Task
Add a `type` field to all link objects. For now, all auto-created links get `type: 'similar'`.

### Changes to make in `src/graph.mjs`:

1. In `store()`, change the link mapping (around the line `links: topLinks.map(...)`) to include `type: 'similar'`:
   ```js
   links: topLinks.map(l => ({ id: l.id, similarity: l.similarity, type: 'similar' })),
   ```

2. In `store()`, where backlinks are pushed to target memories, add `type: 'similar'`:
   ```js
   target.links.push({ id, similarity: link.similarity, type: 'similar' });
   ```

3. In `storeMany()`, same two changes — the link mapping and backlink push should include `type: 'similar'`.

4. Update the JSDoc typedef at the top of graph.mjs. Change:
   ```js
   links: {id: string, similarity: number}[]
   ```
   To:
   ```js
   links: {id: string, similarity: number, type?: string}[]
   ```

### Changes to make in `test/graph.test.mjs`:

Add a new test in the `store` describe block:

```js
it('should create links with type "similar"', async () => {
  const graph = createTestGraph({ config: { linkThreshold: 0.1 } });
  await graph.store('agent-1', 'The user prefers dark mode');
  const r2 = await graph.store('agent-1', 'The user likes dark theme in VS Code');
  
  const mem = graph.memories.find(m => m.id === r2.id);
  for (const link of mem.links) {
    expect(link.type).toBe('similar');
  }
  
  // Verify backlinks also have type
  const first = graph.memories[0];
  for (const link of first.links) {
    expect(link.type).toBe('similar');
  }
});
```

### Verification
After making changes, run `npx vitest run` and ensure:
1. All existing tests still pass (backward compat)
2. The new test passes
3. No other files need changes for this step

When completely finished, run this command to notify me:
openclaw system event --text "Done: Prompt 1 complete - typed edges in store() and backlinks" --mode now
