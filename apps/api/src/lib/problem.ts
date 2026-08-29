import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';

/**
 * RFC 9457 Problem Details. The only error shape this API emits.
 * docs/13-api-design-standards.md §8 — status codes are an allowlist, and every
 * `type` URI must resolve to a real documentation page.
 */
export type ProblemType =
  | 'invalid-parameter'
  | 'not-found'
  | 'method-not-allowed'
  | 'unprocessable'
  | 'rate-limited'
  | 'internal'
  | 'unavailable';

const STATUS_BY_TYPE: Record<ProblemType, number> = {
  'invalid-parameter': 400,
  'not-found': 404,
  'method-not-allowed': 405,
  unprocessable: 422,
  'rate-limited': 429,
  internal: 500,
  unavailable: 503,
};

export interface ProblemInit {
  type: ProblemType;
  title: string;
  detail: string;
  didYouMean?: string[];
}

export class Problem extends HTTPException {
  readonly problem: ProblemInit;

  constructor(init: ProblemInit) {
    super(STATUS_BY_TYPE[init.type] as 400, { message: init.title });
    this.problem = init;
  }
}

export function problemBody(c: Context, init: ProblemInit, docsBase: string) {
  return {
    type: `${docsBase}/errors/${init.type}`,
    title: init.title,
    status: STATUS_BY_TYPE[init.type],
    detail: init.detail,
    instance: new URL(c.req.url).pathname,
    ...(init.didYouMean?.length ? { did_you_mean: init.didYouMean } : {}),
  };
}

export const notFound = (title: string, detail: string, didYouMean?: string[]) =>
  new Problem({ type: 'not-found', title, detail, ...(didYouMean ? { didYouMean } : {}) });

export const invalidParameter = (detail: string) =>
  new Problem({ type: 'invalid-parameter', title: 'Invalid request parameter', detail });
