import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

function resolveMiniappSrcDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(process.cwd(), "apps/miniapp/src"),
    join(here, "../../miniapp/src"),
    join(here, "../../../../apps/miniapp/src"),
  ];
  for (const dir of candidates) {
    if (existsSync(join(dir, "test-ui.html"))) {
      return dir;
    }
  }
  throw new Error(
    "Unable to locate apps/miniapp/src/test-ui.html (run the server from the repository root)",
  );
}

const MINIAPP_SRC_DIR = resolveMiniappSrcDir();
const TEST_UI_DIR = join(MINIAPP_SRC_DIR, "test-ui");

const TEST_UI_MODULES: Readonly<Record<string, string>> = {
  "/test-ui/product-screens.js": "product-screens.ts",
  "/test-ui/machine-diagnostics.js": "machine-diagnostics.ts",
  "/test-ui/telegram-share-signal-log.js": "telegram-share-signal-log.ts",
};

export function testUiHtmlSource(): string {
  return readFileSync(join(MINIAPP_SRC_DIR, "test-ui.html"), "utf8");
}

export function testUiModuleSource(pathname: string): string | null {
  const filename = TEST_UI_MODULES[pathname];
  if (filename === undefined) {
    return null;
  }
  const sourcePath = join(TEST_UI_DIR, filename);
  const source = readFileSync(sourcePath, "utf8");
  const { outputText } = ts.transpileModule(source, {
    fileName: sourcePath,
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      rewriteRelativeImportExtensions: true,
    },
  });
  return outputText.replaceAll(".ts'", ".js'").replaceAll('.ts"', '.js"');
}
