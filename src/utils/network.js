import dns from 'node:dns';

export function normalizeDnsResultOrder(value) {
  return String(value || '').trim().toLowerCase() === 'verbatim' ? 'verbatim' : 'ipv4first';
}

export function configureDnsResultOrder(value = process.env.DNS_RESULT_ORDER) {
  const order = normalizeDnsResultOrder(value);
  dns.setDefaultResultOrder(order);
  return order;
}
