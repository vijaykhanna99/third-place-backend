import { createContext, useContext } from "react";
import type { Api } from "./endpoints";
import type { ApiClient } from "./client";

export interface ApiContextValue {
  api: Api;
  client: ApiClient;
}

export const ApiContext = createContext<ApiContextValue | null>(null);

export function useApi(): Api {
  const value = useContext(ApiContext);
  if (!value) throw new Error("useApi must be used inside <ApiContext.Provider>");
  return value.api;
}
