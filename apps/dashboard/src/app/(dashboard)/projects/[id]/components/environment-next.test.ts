import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api/client";
import { environmentErrorMessage, environmentWizardHref } from "./environment-next";

/**
 * The reported symptom: "the fucking toast doesn't show me error" — while the API
 * had been answering with a perfectly clear sentence about connecting Cloud.
 */
describe("environmentErrorMessage", () => {
  it("shows the SERVER's reason, not 'API 400: Bad Request'", () => {
    // Exactly what the create endpoint returns on a Cloud-disconnected instance.
    const err = new ApiError(400, "Bad Request", {
      success: false,
      error:
        "Connect Openship Cloud to use a free subdomain — free *.opsh.io domains route " +
        "through the Openship Cloud edge. Add a custom domain instead, or connect Cloud in Settings.",
    });
    const msg = environmentErrorMessage(err, "fallback");
    expect(msg).toContain("Connect Openship Cloud");
    // The old code rendered ApiError.message, which is this and nothing else.
    expect(msg).not.toBe("API 400: Bad Request");
    expect(msg).not.toContain("API 400");
  });

  it("falls back only when the payload carries no reason", () => {
    expect(environmentErrorMessage(new ApiError(500, "Server Error", {}), "fallback")).toBe(
      "API 500: Server Error",
    );
    expect(environmentErrorMessage("not an error", "fallback")).toBe("fallback");
  });

  it("passes a plain Error's message through", () => {
    expect(environmentErrorMessage(new Error("boom"), "fallback")).toBe("boom");
  });
});

/**
 * The other half: a new environment has nothing deployed, so it belongs in the
 * wizard rather than on a project page that offers to finish it.
 */
describe("environmentWizardHref", () => {
  it("targets the wizard in config mode, carrying the new project id", () => {
    expect(environmentWizardHref({ id: "proj_9", projectSlug: "site-staging" })).toBe(
      "/deploy/site-staging?projectId=proj_9&mode=config",
    );
  });

  it("encodes a slug that needs it", () => {
    // Slugs reach the URL path; an unencoded one would truncate the route.
    expect(environmentWizardHref({ id: "p", projectSlug: "a/b" })).toContain("/deploy/a%2Fb?");
  });
});
