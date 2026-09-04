import { useCallback, useEffect, useState } from "react";
import { loadCustomModels } from "../lib/customModels";
import { PetWindow } from "./PetWindow";
export function PetRoot() {
  const [modelRegistryVersion, setModelRegistryVersion] = useState(0);
  const reloadCustomModels = useCallback(async () => {
    await loadCustomModels();
    setModelRegistryVersion((version) => version + 1);
  }, []);
  useEffect(() => {
    void reloadCustomModels().catch(() => undefined);
  }, [reloadCustomModels]);
  return <PetWindow modelRegistryVersion={modelRegistryVersion} onModelRegistryReload={reloadCustomModels} />;
}

