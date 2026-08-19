"use strict";

const { spawn } = require("node:child_process");
const path = require("node:path");

function parseArguments(argv) {
  const values = {};
  for (const argument of argv) {
    if (!argument.startsWith("--")) continue;
    const [key, rawValue = "true"] = argument.slice(2).split("=");
    values[key] = rawValue;
  }
  return values;
}

const args = parseArguments(process.argv.slice(2));
const workers = Math.max(1, Math.min(12, Number(args.workers || 4) | 0));
const generator = path.join(__dirname, "generate-teacher-data.js");
const reporter = path.join(__dirname, "report-teacher.js");
const depthReporter = path.join(__dirname, "report-depth.js");
const sequentialTrainer = path.join(__dirname, "train-sequential-policy.js");
const sequentialEvaluator = path.join(__dirname, "evaluate-sequential-policy.js");
const steps = [
  {
    label: "Expand 6k training set to 1,800 seeds",
    script: generator,
    args: [
      "--split=train",
      "--count=1800",
      "--evaluations=6000",
      `--workers=${workers}`,
      "--output=ai-data/teacher-train-pilot.jsonl"
    ]
  },
  {
    label: "Expand 6k validation set to 200 seeds",
    script: generator,
    args: [
      "--split=validation",
      "--count=200",
      "--evaluations=6000",
      `--workers=${workers}`,
      "--output=ai-data/teacher-validation-pilot.jsonl"
    ]
  },
  {
    label: "Generate matched 12k validation set for depth analysis",
    script: generator,
    args: [
      "--split=validation",
      "--count=200",
      "--evaluations=12000",
      "--population=40",
      "--elite-pool=16",
      "--mutation-moves=5",
      "--coordinate-passes=2",
      `--workers=${workers}`,
      "--output=ai-data/depth-ablation-12000.jsonl"
    ]
  },
  {
    label: "Summarise expanded training data",
    script: reporter,
    args: ["--input=ai-data/teacher-train-pilot.jsonl", "--summary-only=true"]
  },
  {
    label: "Summarise expanded validation data",
    script: reporter,
    args: ["--input=ai-data/teacher-validation-pilot.jsonl", "--summary-only=true"]
  },
  {
    label: "Compare 6k and 12k teacher depth",
    script: depthReporter,
    args: [
      "--shallow=ai-data/teacher-validation-pilot.jsonl",
      "--deep=ai-data/depth-ablation-12000.jsonl",
      "--summary-only=true"
    ]
  },
  {
    label: "Train the sequential policy on 1,800 seeds",
    script: sequentialTrainer,
    args: [
      "--input=ai-data/teacher-train-pilot.jsonl",
      "--output=ai-models/sequential-policy-v3-1800.json",
      "--epochs=12",
      "--hidden=48",
      "--negatives=2",
      "--samples-per-seed=4",
      "--learning-rate=0.006"
    ]
  },
  {
    label: "Evaluate the sequential policy on held-out validation seeds",
    script: sequentialEvaluator,
    args: [
      "--model=ai-models/sequential-policy-v3-1800.json",
      "--input=ai-data/teacher-validation-pilot.jsonl",
      "--summary-only=true",
      "--check-repeatability=true",
      "--causal=36"
    ]
  }
];

console.log("Outmaze overnight AI-lab run");
console.log(`Workers: ${workers}`);
console.log("Measured estimate: roughly 4.5-5.75 hours with four workers on this machine.");
console.log("The run is deterministic and resumable; rerun this command after any interruption.\n");
for (const [index, step] of steps.entries()) {
  console.log(`${index + 1}. ${step.label}`);
  console.log(`   ${process.execPath} ${step.script} ${step.args.join(" ")}`);
}
if (args["dry-run"] === "true") process.exit(0);

function runStep(step, index) {
  return new Promise((resolve, reject) => {
    console.log(`\n[${index + 1}/${steps.length}] ${step.label}`);
    const child = spawn(process.execPath, [step.script, ...step.args], { stdio: "inherit" });
    const forwardSignal = () => child.kill("SIGINT");
    process.once("SIGINT", forwardSignal);
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      process.removeListener("SIGINT", forwardSignal);
      if (code === 0) resolve();
      else reject(new Error(`${step.label} stopped with ${signal || `exit code ${code}`}.`));
    });
  });
}

(async () => {
  for (let index = 0; index < steps.length; index++) await runStep(steps[index], index);
  console.log("\nOvernight run complete. Ask Codex to analyse the overnight AI-lab results.");
})().catch((error) => {
  console.error(`\n${error.message}`);
  console.error("No completed records were lost. Run the same command again to resume.");
  process.exitCode = 1;
});
