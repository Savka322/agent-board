import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./i18n/en.json";
import ru from "./i18n/ru.json";

const browserLanguage = typeof navigator !== "undefined" && navigator.language.toLowerCase().startsWith("ru")
  ? "ru"
  : "en";

void i18n.use(initReactI18next).init({
  lng: browserLanguage,
  fallbackLng: "en",
  resources: {
    en: { translation: en },
    ru: { translation: ru },
  },
  interpolation: { escapeValue: false },
});

export default i18n;
