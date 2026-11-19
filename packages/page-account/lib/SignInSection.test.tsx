import { test } from "node:test";
import { FakeIntlProvider } from "@keybr/intl";
import { fireEvent, render } from "@testing-library/react";
import { deepEqual, isNotNull, isNull } from "rich-assert";
import { type SignInActions } from "./actions.ts";
import { SignInSection } from "./SignInSection.tsx";

test("render: alleen eenvoudige login met naam", () => {
  const r = render(
    <FakeIntlProvider>
      <SignInSection actions={{} as SignInActions} />
    </FakeIntlProvider>,
  );

  isNotNull(r.queryByPlaceholderText("voornaam.naam", { exact: false }));
  isNull(r.queryByText("Google", { exact: false }));
  isNull(r.queryByText("Microsoft", { exact: false }));
  isNull(r.queryByText("Facebook", { exact: false }));

  r.unmount();
});

test("inloggen stuurt de naam door", async () => {
  const calls: string[][] = [];
  const r = render(
    <FakeIntlProvider>
      <SignInSection
        actions={
          {
            loginSimple: (username: string) => {
              calls.push([username]);
              return new Promise(() => {}); // blijft "Even geduld..."
            },
          } as unknown as SignInActions
        }
      />
    </FakeIntlProvider>,
  );

  fireEvent.change(r.getByPlaceholderText("voornaam.naam", { exact: false }), {
    target: { value: " emma.peeters " },
  });
  fireEvent.click(r.getByRole("button"));

  await r.findByText("Even geduld", { exact: false });
  deepEqual(calls, [["emma.peeters"]]);

  r.unmount();
});
