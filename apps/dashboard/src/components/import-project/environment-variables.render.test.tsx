// No DOM: renderToStaticMarkup runs no effects, and settings mode needs no
// DeploymentContext (toast has a default context value).
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/components/i18n-provider";
import EnvironmentVariables from "./EnvironmentVariables";

type Props = React.ComponentProps<typeof EnvironmentVariables>;

function render(props: Partial<Props> = {}) {
  return renderToStaticMarkup(
    <I18nProvider>
      <EnvironmentVariables
        mode="settings"
        isEditingMode={true}
        showSettingsActions={false}
        envVars={[]}
        onEnvVarsChange={() => {}}
        {...props}
      />
    </I18nProvider>,
  );
}

function text(html: string) {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

const ROWS = [{ key: "PORT", value: "3000", visible: true }];

describe("EnvironmentVariables empty state", () => {
  it("puts Add Variable inside the empty state, not in a row below it", () => {
    const html = render();
    // The one dashed box, and the CTA lives in it — the bottom add row (the
    // full-width dashed variant) only exists once there are rows to add after.
    expect(html).toContain("border border-dashed");
    expect(html).toContain("bg-primary");
    expect(text(html)).toContain("Add Variable");
    expect(html).not.toContain("border-dashed border-border/60");
    // The hint used to tell the operator to click a button that was outside the
    // box; now the button is in the box, so it only covers paste / drop.
    expect(text(html)).not.toContain('Click "Add Variable"');
    expect(text(html)).toContain("Paste a .env block anywhere in this box");
    // …and only once: the duplicate paste line under the box is gone when empty.
    expect(text(html)).not.toContain("Paste a full .env block");
  });

  it("read-only empty state offers no add affordance", () => {
    const html = render({ isEditingMode: false });
    expect(text(html)).toContain("No environment variables");
    expect(text(html)).toContain('Click "Edit" to manage environment variables');
    expect(text(html)).not.toContain("Add Variable");
  });

  it("with rows, the add affordance becomes the full-width dashed row", () => {
    const html = render({ envVars: ROWS });
    expect(text(html)).not.toContain("No environment variables");
    expect(html).toContain("border-dashed border-border/60");
    expect(text(html)).toContain("Add Variable");
    expect(text(html)).toContain("Paste a full .env block");
  });
});

describe("EnvironmentVariables hideTitle", () => {
  it("keeps the toolbar but drops the title a host header already shows", () => {
    const html = render({ hideTitle: true, borderless: true });
    const out = text(html);
    expect(out).not.toContain("None set");
    expect(out).toContain("Paste .env");
    expect(out).toContain("Upload .env");
    // The panel's own key badge goes with the title — the modal header has one.
    expect(html).not.toContain("bg-violet-500/10");
  });

  it("still renders the title by default", () => {
    const out = text(render());
    expect(out).toContain("Environment Variables");
    expect(out).toContain("None set");
  });
});
