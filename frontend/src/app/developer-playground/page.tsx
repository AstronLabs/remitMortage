// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import DeveloperPlayground from "./DeveloperPlayground";
import { notFound } from "next/navigation";

export default function DeveloperPlaygroundPage() {
  if (process.env.NODE_ENV === "production") {
    notFound();
  }
  return <DeveloperPlayground />;
}
