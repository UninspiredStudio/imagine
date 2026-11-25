const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const EMAIL_ERROR = "Enter a full email address, like you@acme.dev";

export function isEmail(value: string): boolean {
  return EMAIL_PATTERN.test(value.trim());
}

export function initials(email: string): string {
  return email.slice(0, 2).toUpperCase();
}
