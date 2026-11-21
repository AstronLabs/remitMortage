// For more info, see https://github.com/storybookjs/eslint-plugin-storybook#configuration-flat-config-format
import storybook from "eslint-plugin-storybook";

import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

/**
 * Prototype-pollution lint rules (issue #885).
 *
 * The runtime guards live in `src/lib/safe-object.ts`; these rules stop the
 * sinks that make a pollution payload matter from being written in the first
 * place. The repo-wide equivalent for backend source and scripts is
 * `scripts/check-unsafe-merge.mjs`, which also runs on `frontend/src`.
 */
const prototypePollutionRules = {
  name: "remitmortgage/prototype-pollution-guards",
  files: ["src/**/*.{ts,tsx,js,jsx}"],
  // The helpers themselves have to touch the keys they protect against.
  ignores: ["src/lib/safe-object.ts", "**/__tests__/**", "**/__mocks__/**"],
  rules: {
    // `obj.__proto__` — read or written, it is never the right accessor.
    "no-proto": "error",
    // `Object.setPrototypeOf(target, untrusted)` reparents an object wholesale.
    "no-restricted-properties": [
      "error",
      {
        object: "Object",
        property: "setPrototypeOf",
        message:
          "Reparenting an object is a prototype-pollution sink. Build the object you need instead.",
      },
    ],
    "no-restricted-syntax": [
      "error",
      {
        // Object.assign(existing, …): the first argument is the sink. Building
        // a fresh object — Object.assign({}, a, b) / ([], …) / (new Error(), …)
        // — is fine and stays allowed.
        selector:
          "CallExpression[callee.object.name='Object'][callee.property.name='assign']:not([arguments.0.type='ObjectExpression']):not([arguments.0.type='ArrayExpression']):not([arguments.0.type='NewExpression'])",
        message:
          "Object.assign() into an existing object copies attacker-controlled keys. Use safeAssign()/safeMerge() from src/lib/safe-object.ts, or Object.assign({}, …) to build a new object.",
      },
      {
        // Hand-rolled and lodash-style deep merges — the classic CVE surface.
        selector:
          "CallExpression[callee.name=/^(merge|mergeDeep|deepMerge|deepAssign|deepExtend|defaultsDeep|extend)$/]",
        message:
          "Hand-rolled deep merge is the classic prototype-pollution sink. Use safeMerge() from src/lib/safe-object.ts.",
      },
      {
        selector:
          "MemberExpression[computed=true][property.type='Literal'][property.value=/^(__proto__|constructor|prototype)$/]",
        message:
          "Indexing an object by a reserved key reaches a shared prototype. Strip the key with sanitizeDeep() instead.",
      },
    ],
  },
};

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  prototypePollutionRules,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  ...storybook.configs["flat/recommended"],
]);

export default eslintConfig;
