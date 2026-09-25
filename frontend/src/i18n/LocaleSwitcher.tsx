"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { usePathname, useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useTransition } from "react";
import { locales, type Locale } from "./locales";

export function LocaleSwitcher() {
  const t = useTranslations("nav");
  const locale = useLocale() as Locale;
  const router = useRouter();
  const pathname = usePathname() ?? "/";
  const [isPending, startTransition] = useTransition();

  const handleChange = (nextLocale: Locale) => {
    startTransition(() => {
      document.cookie = `NEXT_LOCALE=${nextLocale};path=/;max-age=31536000;samesite=lax`;
      const segments = pathname.split("/").filter(Boolean);
      if (segments[0] && locales.includes(segments[0] as Locale)) {
        segments[0] = nextLocale;
      } else {
        segments.unshift(nextLocale);
      }
      router.replace(`/${segments.join("/")}`);
    });
  };

  return (
    <label className="flex items-center gap-2 text-sm text-slate-300">
      <span className="sr-only">{t("language")}</span>
      <select
        aria-label={t("language")}
        value={locale}
        disabled={isPending}
        onChange={(event) => handleChange(event.target.value as Locale)}
        className="rounded-lg border border-slate-700 bg-slate-900/80 px-2.5 py-2 text-sm text-slate-100 focus:border-cyan-400 focus:outline-none"
      >
        <option value="en">English</option>
        <option value="es">Español</option>
        <option value="fr">Français</option>
      </select>
    </label>
  );
}
