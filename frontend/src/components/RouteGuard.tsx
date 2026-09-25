"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React, { useEffect } from "react";
import { useRouter, usePathname } from "next/navigation";
import { useAuth, getRouteRole } from "@/context/AuthContext";
import { useWallet } from "@/context/WalletContext";

interface RouteGuardProps {
  children: React.ReactNode;
  fallback?: React.ReactNode;
}

export function RouteGuard({ children, fallback }: RouteGuardProps) {
  const router = useRouter();
  const pathname = usePathname();
  const { isConnected } = useWallet();
  const { role, hasAccess } = useAuth();

  const routeRole = getRouteRole(pathname);

  useEffect(() => {
    if (routeRole === "public") return;

    if (!isConnected) {
      router.replace("/");
      return;
    }

    if (!hasAccess(pathname)) {
      router.replace("/unauthorized");
    }
  }, [isConnected, role, pathname, router, hasAccess, routeRole]);

  if (routeRole === "public") return <>{children}</>;

  if (!isConnected) return null;

  if (!hasAccess(pathname)) {
    if (fallback) return <>{fallback}</>;
    return null;
  }

  return <>{children}</>;
}

export default RouteGuard;
