/**
 * Mock Supabase REST API for testing.
 *
 * Simulates the Supabase PostgREST interface in-memory.
 * Supports: GET (with filters), POST, PATCH, DELETE on any table.
 * Used by supabaseStorage tests via custom fetch injection.
 */

export function createMockSupabase() {
  // Tables: { tableName: row[] }
  const tables = {};

  function getTable(name) {
    if (!tables[name]) tables[name] = [];
    return tables[name];
  }

  /**
   * Parse PostgREST query params from URL.
   * Supports: select, order, limit, offset, and filter operators (eq, not.is, is, neq).
   */
  function parseQuery(url) {
    const u = new URL(url);
    const params = {};
    for (const [k, v] of u.searchParams) {
      params[k] = v;
    }
    return { pathname: u.pathname, params };
  }

  function extractTableName(pathname) {
    // /rest/v1/tablename or /rest/v1/rpc/funcname
    const match = pathname.match(/^\/rest\/v1\/([^/?]+)/);
    return match ? match[1] : null;
  }

  function applyFilters(rows, params) {
    let result = [...rows];

    // Apply column filters (e.g. id=eq.xxx, agent_id=eq.yyy)
    for (const [key, val] of Object.entries(params)) {
      if (['select', 'order', 'limit', 'offset'].includes(key)) continue;

      if (val.startsWith('eq.')) {
        const target = val.slice(3);
        result = result.filter(r => String(r[key]) === target);
      } else if (val === 'not.is.null') {
        result = result.filter(r => r[key] != null);
      } else if (val.startsWith('not.is.')) {
        const target = val.slice(7);
        result = result.filter(r => r[key] !== (target === 'null' ? null : target));
      } else if (val.startsWith('or=(')) {
        // Simple OR filter: or=(col1.eq.val1,col2.eq.val2)
        const inner = val.slice(4, -1);
        const clauses = inner.split(',');
        result = result.filter(r => {
          return clauses.some(clause => {
            const [col, op, ...rest] = clause.split('.');
            const target = rest.join('.');
            if (op === 'eq') return String(r[col]) === target;
            return false;
          });
        });
      }
    }

    // Order
    if (params.order) {
      const [col, dir] = params.order.split('.');
      result.sort((a, b) => {
        if (a[col] < b[col]) return dir === 'desc' ? 1 : -1;
        if (a[col] > b[col]) return dir === 'desc' ? -1 : 1;
        return 0;
      });
    }

    // Offset
    if (params.offset) {
      result = result.slice(Number(params.offset));
    }

    // Limit
    if (params.limit) {
      result = result.slice(0, Number(params.limit));
    }

    // Select (filter columns)
    if (params.select) {
      const cols = params.select.split(',').map(c => c.trim());
      result = result.map(r => {
        const filtered = {};
        for (const col of cols) {
          if (col in r) filtered[col] = r[col];
        }
        return filtered;
      });
    }

    return result;
  }

  /** Mock fetch function */
  async function mockFetch(urlStr, opts = {}) {
    const method = (opts.method || 'GET').toUpperCase();
    const { pathname, params } = parseQuery(urlStr);
    const tableName = extractTableName(pathname);

    if (!tableName) {
      return makeResponse(404, 'Not found');
    }

    const table = getTable(tableName);

    switch (method) {
      case 'GET': {
        const filtered = applyFilters(table, params);
        return makeResponse(200, JSON.stringify(filtered));
      }

      case 'POST': {
        const body = JSON.parse(opts.body);
        const rows = Array.isArray(body) ? body : [body];
        const prefer = opts.headers?.['Prefer'] || '';
        const upsert = prefer.includes('resolution=merge-duplicates');

        for (const row of rows) {
          if (upsert && row.id) {
            const idx = table.findIndex(r => r.id === row.id);
            if (idx >= 0) {
              Object.assign(table[idx], row);
              continue;
            }
          }
          table.push(row);
        }

        if (prefer.includes('return=representation')) {
          return makeResponse(201, JSON.stringify(rows));
        }
        return makeResponse(201, '');
      }

      case 'PATCH': {
        const body = JSON.parse(opts.body);
        const targets = applyFilters(table, params);
        for (const target of targets) {
          Object.assign(target, body);
        }
        return makeResponse(200, JSON.stringify(targets));
      }

      case 'DELETE': {
        const filtered = applyFilters(table, params);
        const ids = new Set(filtered.map(r => JSON.stringify(r)));
        const before = table.length;
        tables[tableName] = table.filter(r => !ids.has(JSON.stringify(r)));
        return makeResponse(200, '');
      }

      default:
        return makeResponse(405, 'Method not allowed');
    }
  }

  function makeResponse(status, body) {
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => body,
      json: async () => JSON.parse(body || '[]'),
    };
  }

  return {
    fetch: mockFetch,
    tables,
    getTable,
    /** Reset all tables */
    reset() {
      for (const key of Object.keys(tables)) {
        delete tables[key];
      }
    },
  };
}
