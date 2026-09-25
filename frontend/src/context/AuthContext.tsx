"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React, { createContext, useContext, useMemo } from "react";
import { useWallet } from "./WalletContext";

export type UserRole = "borrower" | "investor" | "contractor" | "admin";

export const ROLE_ROUTES: Record<UserRole, string[]> = {
  borrower: ["/dashboard"],
  investor: ["/invest"],
  contractor: ["/contractor"],
  admin: ["/admin"],
};

export const ALL_ROUTES = [
  "/dashboard",
  "/invest",
  "/contractor",
  "/admin",
  "/governance",
  "/settings",
  "/history",
  "/verify",
  "/repay",
];

export function getRouteRole(pathname: string): UserRole | "public" | "all" {
  if (pathname.startsWith("/dashboard")) return "borrower";
  if (pathname.startsWith("/invest")) return "investor";
  if (pathname.startsWith("/contractor")) return "contractor";
  if (pathname.startsWith("/admin")) return "admin";
  if (
    pathname.startsWith("/governance") ||
    pathname.startsWith("/settings") ||
    pathname.startsWith("/history") ||
    pathname.startsWith("/repay") ||
    pathname.startsWith("/verify")
  )
    return "all";
  return "public";
}

type AuthContextType = {
  role: UserRole | null;
  isAuthorized: boolean;
  isLoading: boolean;
  hasAccess: (pathname: string) => boolean;
  resolveRole: (publicKey: string | null) => UserRole | null;
};

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const ADMIN_ADDRESS =
  process.env.NEXT_PUBLIC_ADMIN_ADDRESS ?? "";

function deriveRole(publicKey: string | null): UserRole | null {
  if (!publicKey) return null;
  if (ADMIN_ADDRESS && publicKey === ADMIN_ADDRESS) return "admin";
  return "borrower";
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const { publicKey, isConnected } = useWallet();

  const role = useMemo<UserRole | null>(
    () => deriveRole(isConnected ? publicKey : null),
    [publicKey, isConnected]
  );

  const isLoading = false;

  const isAuthorized = !!role;

  const resolveRole = (pk: string | null): UserRole | null => deriveRole(pk);

  const hasAccess = (pathname: string): boolean => {
    const routeRole = getRouteRole(pathname);
    if (routeRole === "public" || routeRole === "all") return true;
    return role === routeRole;
  };

  const value: AuthContextType = {
    role,
    isAuthorized,
    isLoading,
    hasAccess,
    resolveRole,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}

export default AuthContext;
