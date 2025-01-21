const DEBUG_MODE = /(true|1|yes)/.test(process.env.DEBUG); // truey

function deepClone(srcObj) {
  return srcObj ? JSON.parse(JSON.stringify(srcObj)) : undefined;
}

function deepAssign(dstObj, ...srcObjs) {
  srcObjs.forEach((obj) => {
    Object.assign(dstObj, deepClone(obj));
  });
  return dstObj;
}

function createHttpError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

module.exports = { createHttpError, deepAssign, deepClone, DEBUG_MODE };
