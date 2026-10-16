import Ajv, { type Options } from 'ajv';

/** Ajv 选项：严格模式（未知关键字、required 中未声明的属性等都会在编译时报错）。 */
export const AJV_OPTIONS: Options = { allErrors: true, strict: true, allowUnionTypes: true };

/** 全局唯一的 Ajv 实例：配置、API 请求体、大模型输出都用它校验（INV-11、§6.5）。 */
export const ajv = new Ajv(AJV_OPTIONS);
