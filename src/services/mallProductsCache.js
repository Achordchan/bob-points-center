const MALL_PRODUCTS_CACHE_TTL_MS = 2500;
const MALL_PRODUCTS_QUERY =
  "SELECT product_id, product_name, bob_amount, stock, limit_per_user, limit_round, status, sort, image_url, remark, updated_at FROM mall_products WHERE status = 'on' ORDER BY (sort IS NULL), sort ASC, product_id COLLATE NOCASE";

const mallProductsCache = {
  snapshot: null,
  cachedAtMs: 0,
  inflight: null,
  generation: 0,
};

async function listMallProducts(db) {
  return await db.all(MALL_PRODUCTS_QUERY);
}

async function getMallProductsVersionInfo(db) {
  const row = await db.get(
    `SELECT
       COUNT(1) AS total,
       COALESCE(MAX(COALESCE(updated_at, 0)), 0) AS updated_max,
       COALESCE(SUM(COALESCE(updated_at, 0)), 0) AS updated_sum
     FROM mall_products
     WHERE status = 'on'`,
  );
  const total = Number(row?.total ?? 0);
  const updatedMax = Number(row?.updated_max ?? 0);
  const updatedSum = Number(row?.updated_sum ?? 0);
  return {
    total,
    version: `${total}:${updatedMax}:${updatedSum}`,
  };
}

export function invalidateMallProductsCache() {
  mallProductsCache.generation += 1;
  mallProductsCache.snapshot = null;
  mallProductsCache.cachedAtMs = 0;
  mallProductsCache.inflight = null;
}

export async function getMallProductsSnapshotCached(db, { force = false } = {}) {
  const nowMs = Date.now();
  if (
    !force &&
    mallProductsCache.snapshot &&
    (nowMs - mallProductsCache.cachedAtMs) < MALL_PRODUCTS_CACHE_TTL_MS
  ) {
    return mallProductsCache.snapshot;
  }
  if (!force && mallProductsCache.inflight) {
    return await mallProductsCache.inflight;
  }
  const generation = mallProductsCache.generation;
  const inflight = (async () => {
    const [rows, versionInfo] = await Promise.all([
      listMallProducts(db),
      getMallProductsVersionInfo(db),
    ]);
    const snapshot = {
      rows: rows || [],
      versionInfo: versionInfo || { total: 0, version: '0:0:0' },
    };
    if (mallProductsCache.generation === generation) {
      mallProductsCache.snapshot = snapshot;
      mallProductsCache.cachedAtMs = Date.now();
    }
    return snapshot;
  })();
  mallProductsCache.inflight = inflight;
  try {
    return await inflight;
  } finally {
    if (mallProductsCache.inflight === inflight && mallProductsCache.generation === generation) {
      mallProductsCache.inflight = null;
    }
  }
}
