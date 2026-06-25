#!/usr/bin/env bun

import { readFileSync } from "fs";
import {
  CURSOR_PRICING_DOC_MARKERS,
  CURSOR_PRICING_DOC_URL,
  checkCursorPricingCoverage,
} from "../src/models/pricing.js";
import {
  discoverModelsFromCursorAgent,
  parseCursorModelsOutput,
} from "../src/models/discovery.js";

type Options = {
  modelsFile?: string;
  skipDocFetch: boolean;
  json: boolean;
};

type DocCheckResult = {
  checked: boolean;
  missingMarkers: string[];
  warning?: string;
};

function parseArgs(argv: string[]): Options {
  const options: Options = { skipDocFetch: false, json: false };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--models-file" && argv[i + 1]) {
      options.modelsFile = argv[i + 1];
      i += 1;
    } else if (arg === "--skip-doc-fetch") {
      options.skipDocFetch = true;
    } else if (arg === "--json") {
      options.json = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

async function fetchPricingDocText(): Promise<string> {
  const response = await fetch(CURSOR_PRICING_DOC_URL);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }

  return response.text();
}

function checkPricingDocText(docText: string): DocCheckResult {
  const normalizedDoc = normalizeForSearch(docText);
  const missingMarkers = CURSOR_PRICING_DOC_MARKERS.filter(marker => {
    return !normalizedDoc.includes(normalizeForSearch(marker));
  });

  return { checked: true, missingMarkers };
}

function normalizeForSearch(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function loadModelIds(options: Options): string[] {
  if (!options.modelsFile) {
    return discoverModelsFromCursorAgent().map(model => model.id);
  }

  const content = readFileSync(options.modelsFile, "utf8");
  const parsedModels = parseCursorModelsOutput(content);
  if (parsedModels.length > 0) {
    return parsedModels.map(model => model.id);
  }

  return content
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
}

async function checkDocs(options: Options): Promise<DocCheckResult> {
  if (options.skipDocFetch) {
    return { checked: false, missingMarkers: [] };
  }

  try {
    return checkPricingDocText(await fetchPricingDocText());
  } catch (error) {
    return {
      checked: false,
      missingMarkers: [],
      warning: error instanceof Error ? error.message : String(error),
    };
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const modelIds = loadModelIds(options);
  const coverage = checkCursorPricingCoverage(modelIds);
  const docCheck = await checkDocs(options);
  const failed = coverage.missing.length > 0;

  if (options.json) {
    console.log(JSON.stringify({ modelCount: modelIds.length, coverage, docCheck }, null, 2));
  } else {
    console.log(`Cursor pricing docs: ${CURSOR_PRICING_DOC_URL}`);
    console.log(`Models checked: ${modelIds.length}`);
    console.log(`Models with pricing: ${coverage.priced.length}`);
    console.log(`Models missing pricing: ${coverage.missing.length}`);

    if (coverage.missing.length > 0) {
      console.log("Missing pricing:");
      for (const modelId of coverage.missing) {
        console.log(`  ${modelId}`);
      }
    }

    if (docCheck.warning) {
      console.log(`Warning: could not fetch Cursor pricing docs (${docCheck.warning})`);
    } else if (docCheck.checked) {
      console.log(`Pricing doc markers checked: ${CURSOR_PRICING_DOC_MARKERS.length}`);
    }

    if (docCheck.missingMarkers.length > 0) {
      console.log("Warning: missing official pricing doc markers:");
      for (const marker of docCheck.missingMarkers) {
        console.log(`  ${marker}`);
      }
    }
  }

  if (failed) {
    process.exit(1);
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
