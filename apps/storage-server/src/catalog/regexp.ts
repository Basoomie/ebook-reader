/**
 * The SQL function behind /regex/ searches (WP7a): ttu_regexp(source, flags, value)
 * is 1 when the JavaScript pattern (Unicode mode, flags '' or 'i') matches value,
 * 0 otherwise (also for NULL). Compiled patterns are cached, so a scan over every
 * title compiles each pattern once.
 */
import type Database from 'better-sqlite3';

const CACHE_SIZE = 16;

export function registerRegexp(db: Database.Database): void {
  const cache = new Map<string, RegExp>();
  db.function(
    'ttu_regexp',
    { deterministic: true, varargs: false },
    (source: unknown, flags: unknown, value: unknown) => {
      if (typeof value !== 'string') return 0;
      const key = `${String(flags)}/${String(source)}`;
      let re = cache.get(key);
      if (!re) {
        re = new RegExp(String(source), flags === 'i' ? 'iu' : 'u');
        if (cache.size >= CACHE_SIZE) cache.delete(cache.keys().next().value as string);
        cache.set(key, re);
      }
      return re.test(value) ? 1 : 0;
    },
  );
}
