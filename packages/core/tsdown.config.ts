import { defineConfig } from "tsdown";

// The build for npm: ES modules in build/. index.js is the library and index.d.ts has its types.
// The workspace runs the source (main is src/index.ts). publishConfig points the published package at the build.
export default defineConfig({
  entry: ["src/index.ts"],
  outDir: "build",
  format: "esm",
  platform: "node",
  fixedExtension: false,
  sourcemap: true,
  dts: true,
  publint: true,
});
