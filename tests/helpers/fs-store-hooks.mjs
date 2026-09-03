/**
 * #1152 — the resolve hook. Every importer of `node:fs` / `fs` / `node:fs/promises`
 * gets the recording wrapper instead; the wrapper itself is exempt, or it would
 * resolve to itself forever.
 */
export async function resolve(spec, ctx, next) {
  const isWrapper = ctx.parentURL && ctx.parentURL.includes('fs-store-wrap');
  if (!isWrapper) {
    if (spec === 'node:fs' || spec === 'fs') {
      return next(new URL('./fs-store-wrap.mjs', import.meta.url).href, ctx);
    }
    if (spec === 'node:fs/promises' || spec === 'fs/promises') {
      return next(new URL('./fs-store-wrap-promises.mjs', import.meta.url).href, ctx);
    }
  }
  return next(spec, ctx);
}
