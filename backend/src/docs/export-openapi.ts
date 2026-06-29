import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { swaggerSpec } from "./swagger.js";
import logger from "../utils/logger.js";

const outputPath = resolve(process.cwd(), "openapi.json");

async function main() {
  await writeFile(outputPath, `${JSON.stringify(swaggerSpec, null, 2)}\n`, "utf8");
  logger.info(`OpenAPI spec written to ${outputPath}`);
}

main().catch((error) => {
  logger.error("Failed to export OpenAPI spec", { error });
  process.exitCode = 1;
});
