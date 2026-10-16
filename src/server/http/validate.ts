import type { ErrorObject, ValidateFunction } from 'ajv';
import { API_SCHEMAS, type ApiSchemaName } from '../../shared/schemas/api';
import { ajv } from '../system/ajv';
import { badRequest } from './errors';

const compiled = new Map<ApiSchemaName, ValidateFunction>();

function validator(name: ApiSchemaName): ValidateFunction {
  let fn = compiled.get(name);
  if (fn === undefined) {
    fn = ajv.compile(API_SCHEMAS[name]);
    compiled.set(name, fn);
  }
  return fn;
}

function describe(errors: ErrorObject[] | null | undefined): string {
  const first = errors?.[0];
  if (first === undefined) return '请求参数不合法';
  const where = first.instancePath === '' ? '请求体' : first.instancePath.slice(1).replace(/\//g, '.');
  if (first.keyword === 'additionalProperties') return `${where} 含有不支持的字段：${String(first.params.additionalProperty)}`;
  if (first.keyword === 'required') return `${where} 缺少字段：${String(first.params.missingProperty)}`;
  return `${where} ${first.message ?? '不合法'}`;
}

/** 按名称校验请求体，失败抛 400 VALIDATION（只报告第一条错误，避免泄露过多细节）。 */
export function validateBody<T>(name: ApiSchemaName, data: unknown): T {
  const fn = validator(name);
  if (!fn(data)) throw badRequest(describe(fn.errors));
  return data as T;
}

/** 启动时预编译全部请求 Schema：Schema 写错会在启动阶段就暴露（§6.5 加载期校验）。 */
export function compileAllApiSchemas(): void {
  for (const name of Object.keys(API_SCHEMAS) as ApiSchemaName[]) validator(name);
}
