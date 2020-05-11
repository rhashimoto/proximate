import typescript from "@rollup/plugin-typescript";
import { terser } from "rollup-plugin-terser";

function config({ format, minify }) {
  const dir = `dist/${format}/`;
  return {
    input: "src/Proximate.ts",
    output: {
      name: "Proximate",
      file: `dist/${format}/Proximate${minify ? ".min" : ""}.js`,
      format,
      sourcemap: true
    },
    plugins: [
      typescript({ noEmitOnError: false }),
      minify ?
      terser({
        sourcemap: true,
        compress: true,
        mangle: true,
        toplevel: true
      }) :
      undefined
    ].filter(Boolean)
  };
}

export default [
  { format: "es",  minify: false },
  { format: "es",  minify: true },
  { format: "umd", minify: false },
  { format: "umd", minify: true }
].map(config);
