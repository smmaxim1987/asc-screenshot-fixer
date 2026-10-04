/**
 * Caps concurrency: the ASC API enforces a hard rate limit (3600 requests/hour),
 * so walking dozens of screenshot sets is done in batches.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      const item = items[index];
      if (item !== undefined) {
        results[index] = await worker(item, index);
      }
    }
  });

  await Promise.all(runners);
  return results;
}