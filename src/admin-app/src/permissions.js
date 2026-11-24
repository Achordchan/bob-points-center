export const navPermissionMap = {
  dashboard: 'dashboard:view',
  users: 'users:view',
  orders: 'orders:view',
  commerce: 'commerce:view',
  activities: 'activities:view',
  gala: 'gala:view',
  messages: 'messages:view',
  content: 'content:view',
  integrations: 'integrations:view',
  audit: 'audit:view',
};

export function hasPermission(user, permission) {
  if (user?.isSuperAdmin) return true;
  return Array.isArray(user?.permissions) && user.permissions.includes(permission);
}

export function canAccessNav(user, key) {
  const permission = navPermissionMap[key];
  return !permission || hasPermission(user, permission);
}
