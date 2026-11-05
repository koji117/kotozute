// 操作の一覧と、呼び出しの入口。Claude のツール、MCP のツール、画面の札がすべてここを通る。
import { z } from 'zod';
import { OpError, type OpContext, type OpDef, type OpResult } from './types';
import { geocodeAddress } from './geocode_address';
import { searchPlace } from './search_place';
import { findFeatures } from './find_features';
import { route } from './route';
import { setView } from './set_view';
import { makeShareLink } from './share';
import { unknownWords } from './unknown_words';
import { planCourse } from './plan_course';
import { checkRoute } from './check_route';
import { addPin } from './add_pin';
import { exportPng } from './export_png';
import { exportRoute } from './export_route';
import { logOp } from '../server/oplog';

export const OPS: OpDef[] = [geocodeAddress, searchPlace, findFeatures, route, setView, makeShareLink, unknownWords, planCourse, checkRoute, addPin, exportPng, exportRoute];

export const findOp = (name: string) => OPS.find((o) => o.name === name);

/**
 * 操作を1回呼ぶ。入力はここで zod で検証する（strict なツールでも最小・最大や文字数は API が強制しないため）。
 * 失敗は投げずに ok:false で返す。呼び出しはすべて操作ログに書く。
 */
export async function runOp(name: string, ctx: OpContext, rawInput: unknown): Promise<OpResult> {
  const op = findOp(name);
  const base = { op: name, title: op?.title ?? name, source: ctx.source };
  const fail = (input: unknown, code: OpError['code'], message: string): OpResult => ({ ...base, input, ok: false, error: { code, message } });
  let r: OpResult;
  if (!op) r = fail(rawInput, 'bad_input', '知らない操作です');
  else {
    const p = op.input.safeParse(rawInput);
    if (!p.success) {
      const fields = [...new Set(p.error.issues.map((i) => i.path[0]).filter((k) => k != null).map(String))];
      r = fail(rawInput, 'bad_input', `入力が正しくありません${fields.length ? `（${fields.join('、')}）` : ''}`);
    } else {
      try {
        r = { ...base, input: p.data, ok: true, output: await op.run(ctx, p.data) };
      } catch (e) {
        if (e instanceof OpError) r = fail(p.data, e.code, e.message);
        else {
          console.error(`[op ${name}]`, e);
          r = fail(p.data, 'service', '処理の途中でエラーが起きました。もう一度試してください');
        }
      }
    }
  }
  logOp(ctx.session, r);
  return r;
}

export interface ToolDef {
  name: string;
  description: string;
  input_schema: { type: 'object'; [k: string]: unknown };
  strict: true;
}

/** Claude に渡すツールの定義。毎回同じ並びと同じ中身になる（プロンプトのキャッシュが効くように） */
export const toolDefs = (): ToolDef[] =>
  OPS.map((op) => ({
    name: op.name,
    description: op.description,
    input_schema: strictSchema(z.toJSONSchema(op.input, { io: 'input' })) as ToolDef['input_schema'],
    strict: true,
  }));

type Json = Record<string, any>;
const KEEP = new Set(['type', 'enum', 'const', 'description']);

/**
 * zod の JSON Schema を strict なツールの形にする。
 * - object は全部のキーを required にし、additionalProperties: false を付ける
 * - API が受け付けない制約（最小・最大、文字数、pattern、default など）は説明文に移す。検証は runOp で行う
 */
// ponytail: 省略可能なキー（optional）も required になる。今の操作にはない。足すなら .nullable() で書く
export function strictSchema(s: Json): Json {
  const out: Json = {};
  const moved: string[] = [];
  for (const [k, v] of Object.entries(s)) {
    if (k === '$schema' || k === 'required' || k === 'additionalProperties') continue;
    if (k === 'properties') out.properties = Object.fromEntries(Object.entries(v as Json).map(([pk, pv]) => [pk, strictSchema(pv)]));
    else if (k === 'items') out.items = strictSchema(v);
    else if (k === 'anyOf') out.anyOf = (v as Json[]).map(strictSchema);
    else if (k === 'minItems' && v <= 1) out.minItems = v;
    else if (KEEP.has(k)) out[k] = v;
    else moved.push(`${k}: ${JSON.stringify(v)}`);
  }
  if (out.type === 'object') {
    out.properties ??= {};
    out.required = Object.keys(out.properties);
    out.additionalProperties = false;
  }
  if (moved.length) out.description = [out.description, `{${moved.join(', ')}}`].filter(Boolean).join(' ');
  return out;
}
