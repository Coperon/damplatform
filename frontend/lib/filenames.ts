import type { Pool, PoolClient } from 'pg';

type Executor = Pool | PoolClient;

/**
 * Splits on the LAST dot only, so "my.file.name.jpg" -> ("my.file.name", ".jpg").
 * A dot at index 0 (".gitignore") or no dot at all ("README") means there is
 * no real extension — the whole name is the base, so a suffix still lands
 * before anything meaningful rather than after a fake ".gitignore" "ext".
 */
export function splitFilename(name: string): { base: string; ext: string } {
  const lastDot = name.lastIndexOf('.');
  if (lastDot <= 0) {
    return { base: name, ext: '' };
  }
  return { base: name.slice(0, lastDot), ext: name.slice(lastDot) };
}

/**
 * Windows-Downloads-style dedupe: "photo.jpg" -> "photo (1).jpg" -> "photo (2).jpg".
 * Comparison is case-insensitive. This never parses a "(N)" suffix out of the
 * incoming name — an incoming "photo (1).jpg" that collides becomes
 * "photo (1) (1).jpg", not "photo (2).jpg" — so a legitimately-named file
 * that happens to already look like a suffixed one is never misread as one.
 */
export function dedupeFilename(desiredName: string, existingNames: string[]): string {
  const { base, ext } = splitFilename(desiredName);
  const taken = new Set(existingNames.map((n) => n.toLowerCase()));

  const candidate = `${base}${ext}`;
  if (!taken.has(candidate.toLowerCase())) return candidate;

  let n = 1;
  let next = `${base} (${n})${ext}`;
  while (taken.has(next.toLowerCase())) {
    n += 1;
    next = `${base} (${n})${ext}`;
  }
  return next;
}

/**
 * Scope: resources linked to `collectionId`, or — when `collectionId` is
 * null — resources linked to no collection at all (the "Unassigned" set,
 * same definition GET /api/media uses). One query fetches every name in
 * scope; the free suffix is computed in JS rather than a round trip per
 * candidate N.
 */
async function fetchExistingFilenames(
  executor: Executor,
  collectionId: string | null,
): Promise<string[]> {
  if (collectionId != null) {
    const result = await executor.query(
      `SELECT r.original_filename
         FROM resources r
         JOIN collection_resource cr ON cr.resource_id = r.id
        WHERE cr.collection_id = $1`,
      [collectionId],
    );
    return result.rows.map((row) => row.original_filename as string);
  }

  const result = await executor.query(
    `SELECT r.original_filename
       FROM resources r
      WHERE NOT EXISTS (
        SELECT 1 FROM collection_resource cr WHERE cr.resource_id = r.id
      )`,
  );
  return result.rows.map((row) => row.original_filename as string);
}

/**
 * Fetch the names already in scope and compute a free name for `desiredName`.
 * Call this immediately before the INSERT — ideally on the same transaction
 * client that performs the insert — to keep the check-then-insert window as
 * small as possible. Sequential uploads make collisions unlikely in practice,
 * but under READ COMMITTED this is still a check-then-insert race: two
 * concurrent requests could both see the name free and both insert it. Not
 * closed with a lock here — accepted residual risk, not worth a unique
 * constraint or advisory lock for this feature.
 */
export async function resolveUniqueFilename(
  executor: Executor,
  collectionId: string | null,
  desiredName: string,
): Promise<string> {
  const existing = await fetchExistingFilenames(executor, collectionId);
  return dedupeFilename(desiredName, existing);
}
