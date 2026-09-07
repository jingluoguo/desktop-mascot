import type { LivelyMascotApi } from "../types";
import livelyMascot from "lively-mascot";

// Use the package's ESM export. The legacy browser bundle assigns its runtime
// to a global only when loaded as a classic script, which is not true in a
// production Vite bundle.
const getLivelyMascot = (): LivelyMascotApi => livelyMascot;
export { getLivelyMascot };
