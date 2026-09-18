const util = require("node:util");
const original = util.styleText;

if (typeof original === "function") {
  util.styleText = function styleText(format, text, ...rest) {
    if (Array.isArray(format)) {
      return format.reduce(
        (acc, item) => original.call(util, item, acc, ...rest),
        text
      );
    }
    return original.call(util, format, text, ...rest);
  };
  require("node:module").syncBuiltinESMExports();
}
