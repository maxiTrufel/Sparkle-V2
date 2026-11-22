const ROLE_STORAGE_KEY = 'sparkle-v2-role';

export function getStoredRole() {
  const value = localStorage.getItem(ROLE_STORAGE_KEY);
  return value === 'teacher' || value === 'student' ? value : null;
}

export function setStoredRole(role) {
  localStorage.setItem(ROLE_STORAGE_KEY, role);
}
