import { register } from "@shopify/web-pixels-extension";
import { createTracker } from "./tracker";

register((api) => {
  createTracker(api);
});
