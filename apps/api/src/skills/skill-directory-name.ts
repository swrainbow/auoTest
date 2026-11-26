export function isSkillDirectoryName(value: unknown): value is string {
  return typeof value === 'string' && /^[\p{Script=Han}a-z0-9]+(?:-[\p{Script=Han}a-z0-9]+)*$/u.test(value);
}
