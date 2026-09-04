import "lively-mascot/dist/lively-mascot.min.js";
import "lively-mascot/dist/lively-mascot.min.css";
import "./App.css";
import { ContextMenuWindow } from "./components/ContextMenuWindow";
import { PetRoot } from "./components/PetRoot";
import { SettingsWindow } from "./components/SettingsWindow";
function App() {
  const view = new URLSearchParams(window.location.search).get("view");
  if (view === "settings") return <SettingsWindow />;
  if (view === "context-menu") return <ContextMenuWindow />;
  return <PetRoot />;
}

export default App;
