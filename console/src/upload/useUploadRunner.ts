import { useCallback, useEffect, useRef } from "react";
import { useApi } from "../api/ApiContext";
import { runUpload } from "./runUpload";
import type { UploadEvent } from "./uploadMachine";

/**
 * Starts and cancels angle uploads by key. Uploads keep running while the
 * owner re-renders; every in-flight one is aborted when the owner unmounts.
 */
export function useUploadRunner() {
  const api = useApi();
  const controllers = useRef(new Map<string, AbortController>());

  useEffect(() => {
    const live = controllers.current;
    return () => {
      for (const controller of live.values()) controller.abort();
      live.clear();
    };
  }, []);

  const cancel = useCallback((key: string) => {
    controllers.current.get(key)?.abort();
    controllers.current.delete(key);
  }, []);

  const start = useCallback(
    (key: string, file: File, dispatch: (event: UploadEvent) => void) => {
      controllers.current.get(key)?.abort();
      const controller = new AbortController();
      controllers.current.set(key, controller);
      void runUpload({ api, file, dispatch, signal: controller.signal }).finally(() => {
        if (controllers.current.get(key) === controller) controllers.current.delete(key);
      });
    },
    [api],
  );

  return { start, cancel };
}
