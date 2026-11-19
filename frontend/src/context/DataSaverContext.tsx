"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { createContext, useContext, useEffect, useState } from "react";
import {
  getDataSaverDefault,
  getHighContrastDefault,
  persistDataSaver,
  persistHighContrast,
} from "../lib/dataSaver";

type DataSaverContextValue = {
  dataSaver: boolean;
  highContrast: boolean;
  setDataSaver: (enabled: boolean) => void;
  setHighContrast: (enabled: boolean) => void;
};

const DataSaverContext = createContext<DataSaverContextValue | null>(null);

export function DataSaverProvider({ children }: { children: React.ReactNode }) {
  const [dataSaver, setDataSaverState] = useState(false);
  const [highContrast, setHighContrastState] = useState(false);

  useEffect(() => {
    setDataSaverState(getDataSaverDefault());
    setHighContrastState(getHighContrastDefault());
  }, []);

  function setDataSaver(enabled: boolean) {
    persistDataSaver(enabled);
    setDataSaverState(enabled);
  }

  function setHighContrast(enabled: boolean) {
    persistHighContrast(enabled);
    setHighContrastState(enabled);
  }

  useEffect(() => {
    document.documentElement.toggleAttribute("data-high-contrast", highContrast);
  }, [highContrast]);

  return (
    <DataSaverContext.Provider value={{ dataSaver, highContrast, setDataSaver, setHighContrast }}>
      {children}
    </DataSaverContext.Provider>
  );
}

export function useDataSaver() {
  const context = useContext(DataSaverContext);
  if (!context) throw new Error("useDataSaver must be used within DataSaverProvider");
  return context;
}
