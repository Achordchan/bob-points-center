function toInt(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
  return n;
}

function normalizeStatus(value) {
  const v = value === null || value === undefined ? '' : String(value).trim().toLowerCase();
  if (v === 'on' || v === 'off') return v;
  return 'on';
}

function normalizeFlag(value) {
  if (value === true || value === 1 || value === '1' || value === 'true' || value === 'on') return 1;
  return 0;
}

export function normalizeMallProductInput(body) {
  const productId = body?.product_id ? String(body.product_id).trim() : '';
  const productName = body?.product_name ? String(body.product_name).trim() : '';
  const amount = toInt(body?.bob_amount);

  const stockRaw = body?.stock;
  const stock = stockRaw === null || stockRaw === undefined || String(stockRaw).trim() === '' ? null : toInt(stockRaw);

  const sortRaw = body?.sort;
  const sort = sortRaw === null || sortRaw === undefined || String(sortRaw).trim() === '' ? null : toInt(sortRaw);

  const limitRaw = body?.limit_per_user;
  const limitPerUser = limitRaw === null || limitRaw === undefined || String(limitRaw).trim() === '' ? 0 : toInt(limitRaw);

  const status = normalizeStatus(body?.status);
  const cdkEnabled = normalizeFlag(body?.cdk_enabled);
  const imageUrl = body?.image_url ? String(body.image_url).trim() : '';
  const remark = body?.remark ? String(body.remark).trim() : '';

  if (!productId) {
    throw new Error('missing product_id');
  }
  if (!productName) {
    throw new Error('missing product_name');
  }
  if (amount === null || amount <= 0) {
    throw new Error('bob_amount must be positive integer');
  }
  if (stock !== null && (stock === null || stock < 0)) {
    throw new Error('invalid stock');
  }
  if (limitPerUser === null || limitPerUser < 0) {
    throw new Error('limit_per_user must be >= 0');
  }

  return {
    product_id: productId,
    product_name: productName,
    bob_amount: amount,
    stock,
    limit_per_user: limitPerUser,
    cdk_enabled: cdkEnabled,
    status,
    sort,
    image_url: imageUrl,
    remark,
  };
}
