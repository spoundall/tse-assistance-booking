import { createTranslator, supportedLanguages } from "./i18n.js";

const languageKey = "tse-apex-language";
const assistanceBookingUrl = "/book-recovery";

const state = {
  language: loadLanguage(),
  t: createTranslator(loadLanguage()),
};

const elements = {
  languageSelect: document.querySelector("#languageSelect"),
  openBooking: document.querySelector("#openBooking"),
};

elements.languageSelect.value = state.language;

applyLanguage();
persistLanguageForBookingScreen();

elements.languageSelect.addEventListener("change", () => {
  state.language = elements.languageSelect.value;
  state.t = createTranslator(state.language);
  localStorage.setItem(languageKey, state.language);
  persistLanguageForBookingScreen();
  applyLanguage();
});

elements.openBooking.addEventListener("click", () => {
  window.location.href = assistanceBookingUrl;
});

function loadLanguage() {
  const saved = localStorage.getItem(languageKey);
  return supportedLanguages.includes(saved) ? saved : "en";
}

function applyLanguage() {
  document.documentElement.lang = state.language;
  document.querySelectorAll("[data-i18n]").forEach((node) => {
    node.textContent = state.t(node.dataset.i18n);
  });
  elements.languageSelect.setAttribute("aria-label", state.t("language.label"));
}

function persistLanguageForBookingScreen() {
  document.cookie = `tse-language=${encodeURIComponent(state.language)}; path=/; max-age=31536000; SameSite=Lax`;
}
