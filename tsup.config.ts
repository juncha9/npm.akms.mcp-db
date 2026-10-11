import { defineConfig } from "tsup";

export default defineConfig([
    // 라이브러리 입구 — 다른 도구 · 시험이 서버를 끼워 쓰거나 가드만 가져다 쓴다.
    {
        entry: ["src/index.ts"],
        format: ["esm", "cjs"],
        target: "node22",
        platform: "node",
        outDir: "lib",
        dts: true,
        sourcemap: true,
        clean: false,
        treeshake: true,
        splitting: false,
        minify: false,
        tsconfig: "./tsconfig.json",
    },
    // 명령줄 — MCP 클라이언트가 stdio 로 띄우는 실행 파일.
    {
        entry: ["src/cli.ts"],
        format: ["esm"],
        target: "node22",
        platform: "node",
        outDir: "lib",
        dts: false,
        sourcemap: true,
        clean: false,
        treeshake: true,
        splitting: false,
        minify: false,
        banner: { js: "#!/usr/bin/env node" },
        tsconfig: "./tsconfig.json",
    },
]);
