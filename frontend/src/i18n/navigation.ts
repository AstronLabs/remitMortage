// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { createNavigation } from "next-intl/navigation";
import { locales } from "./locales";

export const { Link, redirect, usePathname, useRouter } = createNavigation({
  locales,
  localePrefix: "never",
});
