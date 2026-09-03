export async function resolve(specifier, context, next) {
  if (specifier === 'oxigraph') {
    const e = new Error("Cannot find package 'oxigraph' imported from a fresh clone");
    e.code = 'ERR_MODULE_NOT_FOUND';
    throw e;
  }
  return next(specifier, context);
}
