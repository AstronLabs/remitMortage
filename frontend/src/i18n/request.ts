// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { getRequestConfig } from "next-intl/server";
import { cookies } from "next/headers";
import { isLocale, locales } from "./locales";

export { locales } from "./locales";
export type { Locale } from "./locales";

export default getRequestConfig(async () => {
  const cookieStore = await cookies();
  const localeCookie = cookieStore.get("NEXT_LOCALE")?.value;
  const locale = isLocale(localeCookie ?? "") ? localeCookie : "en";

  return {
    locale: locale ?? "en",
    messages: (await import(`./messages/${locale}.json`)).default,
  };
});
