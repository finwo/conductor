// src/lib/visibility.js - who may see a row

// SQL for lists, so a count and its page cannot disagree.
export function visibleSql(user, { visibility, owner }) {
  if (user?.role === 'admin') return { where: '1 = 1', params: {} };
  if (user) {
    return {
      where: `(${visibility} = 'public' OR ${owner} = {viewerId})`,
      params: { viewerId: user.id },
    };
  }
  return { where: `${visibility} = 'public'`, params: {} };
}

// A null owner matches nobody: an unowned row is administered centrally.
export function canManage(user, ownerId) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  return ownerId != null && ownerId === user.id;
}

export function canView(user, { visibility, ownerId }) {
  if (visibility === 'public') return true;
  return canManage(user, ownerId);
}
