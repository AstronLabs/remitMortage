// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import type { Metadata } from "next";
import EmailPreviewClient from "./EmailPreviewClient";

export const metadata: Metadata = {
  title: "Email Template Preview | Internal Tools",
  description: "Internal tool for previewing transactional email templates",
  robots: { index: false, follow: false },
};

export default function EmailPreviewPage() {
  return <EmailPreviewClient />;
}