import { describe, expect, it } from "vitest";
import { azureOpenAIBaseUrl } from "../../src/app/runtime.js";

describe("Azure OpenAI runtime configuration", () => {
  it("uses the stable Azure OpenAI v1 endpoint without preview query parameters", () => {
    expect(
      azureOpenAIBaseUrl("https://example.openai.azure.com/custom?api-version=preview#fragment"),
    ).toBe("https://example.openai.azure.com/openai/v1/");
  });
});
