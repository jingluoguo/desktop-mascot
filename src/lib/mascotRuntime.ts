import type { LivelyMascotApi } from "../types";
const getLivelyMascot = () => (window as Window & { LivelyMascot?: LivelyMascotApi }).LivelyMascot;
export { getLivelyMascot };
