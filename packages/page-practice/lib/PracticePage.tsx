import { KeyboardOptions, Layout } from "@keybr/keyboard";
import { Settings } from "@keybr/settings";
import { ViewSwitch } from "@keybr/widget";
import { views } from "./views.tsx";

setDefaultLayout();

function setDefaultLayout() {
  Settings.addDefaults(
    KeyboardOptions.default()
      .withLanguage(Layout.NL_BE.language)
      .withLayout(Layout.NL_BE)
      .save(new Settings()),
  );
}

export function PracticePage() {
  return <ViewSwitch views={views} />;
}
