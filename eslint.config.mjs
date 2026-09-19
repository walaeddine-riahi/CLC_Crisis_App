import { FlatCompat } from "@eslint/eslintrc";
import { defineConfig, globalIgnores } from "eslint/config";

const compat = new FlatCompat({ baseDirectory: import.meta.dirname });
const config = defineConfig([
  globalIgnores([".next/**", "node_modules/**", "public/**"]),
  ...compat.extends("next/core-web-vitals", "next/typescript"),
]);

export default config;
