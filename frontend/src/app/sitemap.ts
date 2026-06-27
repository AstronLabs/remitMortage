import type { MetadataRoute } from "next";

const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL ?? "https://remitmortgage.com";

const STATIC_ROUTES: {
  path: string;
  changeFrequency: MetadataRoute.Sitemap[number]["changeFrequency"];
  priority: number;
}[] = [
  { path: "/", changeFrequency: "weekly", priority: 1.0 },
  { path: "/dashboard", changeFrequency: "daily", priority: 0.9 },
  { path: "/governance", changeFrequency: "daily", priority: 0.8 },
  { path: "/invest", changeFrequency: "weekly", priority: 0.8 },
  { path: "/repay", changeFrequency: "weekly", priority: 0.7 },
  { path: "/history", changeFrequency: "daily", priority: 0.7 },
  { path: "/stats", changeFrequency: "daily", priority: 0.7 },
  { path: "/analytics", changeFrequency: "daily", priority: 0.6 },
  { path: "/contractor", changeFrequency: "weekly", priority: 0.6 },
  { path: "/settings", changeFrequency: "monthly", priority: 0.4 },
];

export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date();

  return STATIC_ROUTES.map(({ path, changeFrequency, priority }) => ({
    url: `${BASE_URL}${path}`,
    lastModified,
    changeFrequency,
    priority,
  }));
}
