export function formatTs(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return '-';
  return new Date(n * 1000).toLocaleString('zh-CN', { hour12: false });
}

export function amountText(value) {
  const n = Number(value || 0);
  return `${Number.isFinite(n) ? n : 0} BOB`;
}

export function orderAmount(row) {
  if (row?.redeem_source === 'cdk') return Number(row?.cdk_product_bob_amount || row?.bob_amount || 0);
  return Number(row?.bob_amount || 0);
}

export function boolText(value) {
  return Number(value) === 1 || value === true ? '是' : '否';
}

export function toUnix(value) {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

export function downloadText(filename, text) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}


export function localTablePagination(label = '条', pageSize = 10) {
  return {
    defaultPageSize: pageSize,
    showSizeChanger: true,
    pageSizeOptions: [10, 20, 30, 50, 100],
    showTotal: (total) => `共 ${total} ${label}`,
  };
}
