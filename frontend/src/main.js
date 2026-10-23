import { createApp } from "vue";
import Dock from "./Dock.vue";
import Overlay from "./Overlay.vue";
import "./style.css";

const overlay = location.pathname === "/overlay";
document.documentElement.classList.toggle("overlay-page", overlay);
createApp(overlay ? Overlay : Dock).mount("#app");
