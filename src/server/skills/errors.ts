/** 技能包不合法（INV-13）：http 层映射为 422 SKILL_INVALID。 */
export class SkillInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillInvalidError';
  }
}

/** SkillHub 不可用（网络错误、超时、5xx、响应格式不对）：http 层映射为 502 HUB_ERROR。不影响本地导入与编辑。 */
export class HubError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HubError';
  }
}

export const skillInvalid = (message: string): SkillInvalidError => new SkillInvalidError(message);
