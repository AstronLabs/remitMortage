// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { Router, Request, Response } from "express";
import { getErrorCatalog, lookupErrorCode } from "../errors/catalog.js";

export const errorCatalogRouter = Router();

errorCatalogRouter.get("/", (_req: Request, res: Response) => {
  const errors = getErrorCatalog();
  res.status(200).json({
    version: "1.0",
    count: errors.length,
    errors,
  });
});

errorCatalogRouter.get("/:code", (req: Request, res: Response) => {
  const entry = lookupErrorCode(String(req.params.code));
  if (!entry) {
    const notFound = lookupErrorCode("NOT_FOUND")!;
    return res.status(notFound.httpStatus).json({
      error: notFound.code,
      code: notFound.code,
      message: `Error code '${req.params.code}' is not in the catalog`,
      remediation: notFound.remediation,
      statusCode: notFound.httpStatus,
    });
  }
  return res.status(200).json(entry);
});
