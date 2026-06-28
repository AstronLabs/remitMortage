import { loadEnvFile } from "process";
loadEnvFile();

export default {
  earlyAccess: true,
  schema: {
    kind: "single",
    filePath: "prisma/schema.prisma",
  },
  migrate: {
    url: process.env.DATABASE_URL,
  },
};
