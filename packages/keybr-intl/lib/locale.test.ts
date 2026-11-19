import { test } from "node:test";
import { equal } from "rich-assert";
import { selectLocale } from "./locale.ts";

test("select locale", () => {
  const filter =
    (...found: string[]) =>
    (...locales: string[]) =>
      locales.find((locale) => found.includes(locale)) ?? null;
  equal(selectLocale(filter()), "nl"); // standaardtaal van de fork
  equal(selectLocale(filter("xx")), "nl");
  equal(selectLocale(filter("en")), "nl"); // fork: geen Engels, ook Engelse browsers krijgen nl
  equal(selectLocale(filter("en-US")), "nl");
  equal(selectLocale(filter("en-CA")), "nl");
  equal(selectLocale(filter("pt")), "pt-br");
  equal(selectLocale(filter("pt-BR")), "pt-br");
  equal(selectLocale(filter("pt-PT")), "pt-pt");
  equal(selectLocale(filter("zh")), "zh-hans");
  equal(selectLocale(filter("zh-CN")), "zh-hans");
  equal(selectLocale(filter("zh-TW")), "zh-tw");
});
