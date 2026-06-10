#!/usr/bin/env bun
import { resolve } from "node:path";
import {
  formatToolCallRegressionFailures,
  runToolCallRegressionCases,
  toolCallRegressionExitCode,
  type ToolCallRegressionReport,
} from "@chatman-media/kb";

interface CliArgs {
  filePath: string;
  supportedTools: string[];
  includeArchived: boolean;
  skipUnsupported: boolean;
  json: boolean;
  help: boolean;
}

const defaultFilePath = resolve("tool-call-regression-cases.jsonl");

function parseArgs(argv: string[]): CliArgs | { error: string } {
  const args: CliArgs = {
    filePath: defaultFilePath,
    supportedTools: [],
    includeArchived: false,
    skipUnsupported: false,
    json: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    if (!raw) continue;

    if (raw === "--help" || raw === "-h") args.help = true;
    else if (raw === "--json") args.json = true;
    else if (raw === "--include-archived") args.includeArchived = true;
    else if (raw === "--skip-unsupported") args.skipUnsupported = true;
    else if (raw === "--file") {
      const next = argv[index + 1];
      if (!next) return { error: "--file requires a path" };
      args.filePath = resolve(next);
      index += 1;
    } else if (raw.startsWith("--file=")) {
      args.filePath = resolve(raw.slice("--file=".length));
    } else if (raw === "--tool") {
      const next = argv[index + 1];
      if (!next) return { error: "--tool requires a name" };
      addTools(args.supportedTools, next);
      index += 1;
    } else if (raw.startsWith("--tool=")) {
      addTools(args.supportedTools, raw.slice("--tool=".length));
    } else if (raw === "--tools") {
      const next = argv[index + 1];
      if (!next) return { error: "--tools requires a comma-separated list" };
      addTools(args.supportedTools, next);
      index += 1;
    } else if (raw.startsWith("--tools=")) {
      addTools(args.supportedTools, raw.slice("--tools=".length));
    } else {
      return { error: `unknown argument: ${raw}` };
    }
  }

  return args;
}

function addTools(tools: string[], raw: string) {
  for (const tool of raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)) {
    if (!tools.includes(tool)) tools.push(tool);
  }
}

function printHelp() {
  console.log(`Usage:
  bun run quality:tool-regressions -- --file tool-call-regression-cases.jsonl [options]

Options:
  --file <path>             JSONL export from Quality Lab. Default: ./tool-call-regression-cases.jsonl
  --tool <name>             Supported tool name. Can be repeated.
  --tools <a,b,c>           Supported tool names as a comma-separated list.
  --include-archived        Validate archived cases too. By default they are skipped and counted.
  --skip-unsupported        Skip cases whose toolName is not in --tool/--tools.
  --json                    Print the full machine-readable report.
  --help                    Show this help.
`);
}

async function main() {
  const args = parseArgs(Bun.argv.slice(2));
  if ("error" in args) {
    console.error(args.error);
    printHelp();
    process.exitCode = 1;
    return;
  }
  if (args.help) {
    printHelp();
    return;
  }

  const raw = await Bun.file(args.filePath).text();
  const report = runToolCallRegressionCases({
    raw,
    includeArchived: args.includeArchived,
    skipUnsupported: args.skipUnsupported,
    supportedTools: args.supportedTools.length > 0 ? args.supportedTools : undefined,
    metadata: {
      filePath: args.filePath,
      ...(args.supportedTools.length > 0 ? { supportedTools: args.supportedTools } : {}),
    },
  });

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printSummary(report);
    const failures = formatToolCallRegressionFailures(report);
    if (failures) {
      console.error("\nFailures:\n");
      console.error(failures);
    }
  }

  process.exitCode = toolCallRegressionExitCode(report);
}

function printSummary(report: ToolCallRegressionReport) {
  const { summary } = report;
  console.log(
    [
      "Tool-call regression cases:",
      `total=${summary.total}`,
      `passed=${summary.passed}`,
      `failed=${summary.failed}`,
      `skipped=${summary.skipped}`,
    ].join(" "),
  );

  const skipReasons = Object.entries(summary.skipReasons);
  if (skipReasons.length > 0) {
    console.log(
      `Skipped: ${skipReasons
        .map(([reason, count]) => `${reason}=${count}`)
        .join(" ")}`,
    );
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exitCode = 1;
});
